/**
 * Route handlers for swap REST API endpoints.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    type IApiError,
    type IApiResponse,
    type ICreateSwapParams,
    type IPaginationParams,
    type ISwapRecord,
    type IUpdateSwapParams,
    type ITakeSwapBody,
    SwapStatus,
    calculateXmrFee,
    calculateXmrTotal,
    safeParseAmount,
    MIN_XMR_AMOUNT_PICONERO,
} from '../types.js';
import { StorageService } from '../storage.js';
import { SwapStateMachine } from '../state-machine.js';
import { SwapWebSocketServer } from '../websocket.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getFeeAddress, setFeeAddress, verifyPreimage, validateMoneroAddress } from '../monero-module.js';
import { ed25519PublicFromPrivate, verifyBobKeyProof, verifyCrossCurveDleq, validateViewKeyScalar } from '../crypto/index.js';
import { createLogger } from '../logger.js';

const log = createLogger('routes');

/**
 * Constant-time token comparison that does NOT leak token length via early-return.
 * Hashes both values before comparing — always compares 32-byte digests regardless of input length.
 */
function safeTokenCompare(expected: string, provided: string): boolean {
    const hashExpected = createHash('sha256').update(expected).digest();
    const hashProvided = createHash('sha256').update(provided).digest();
    return timingSafeEqual(hashExpected, hashProvided);
}

/** Returns true if DLEQ proofs are mandatory (env-driven enforcement toggle). */
function isDleqRequired(): boolean {
    if (process.env['REQUIRE_DLEQ'] === 'true') return true;
    const after = process.env['DLEQ_REQUIRED_AFTER'];
    if (after) {
        const date = new Date(after);
        if (Number.isNaN(date.getTime())) {
            console.error(`[DLEQ] DLEQ_REQUIRED_AFTER is an invalid date: "${after}" — treating as REQUIRED for safety`);
            return true;
        }
        if (new Date() >= date) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Per-swap operation lock to prevent TOCTOU races
// ---------------------------------------------------------------------------

const swapOperationLocks = new Map<string, Promise<void>>();

/** Maximum time (ms) to wait for a swap lock before timing out. */
const SWAP_LOCK_TIMEOUT_MS = 30_000;

/** Thrown when a swap lock times out — callers should return 503. */
export class SwapLockTimeoutError extends Error {
    public constructor(swapId: string) {
        super(`Swap lock timeout after ${SWAP_LOCK_TIMEOUT_MS}ms for swap ${swapId}`);
        this.name = 'SwapLockTimeoutError';
    }
}

/**
 * Serializes concurrent operations on the same swap.
 * Prevents TOCTOU race conditions where two requests check state simultaneously.
 * Times out after SWAP_LOCK_TIMEOUT_MS to prevent deadlocks.
 */
export async function withSwapLock<T>(swapId: string, fn: () => Promise<T>): Promise<T> {
    const prev = swapOperationLocks.get(swapId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
    swapOperationLocks.set(swapId, lockPromise);

    // Race the previous lock against a timeout
    const timeout = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new SwapLockTimeoutError(swapId));
        }, SWAP_LOCK_TIMEOUT_MS);
        timer.unref(); // Don't block process exit
    });

    try {
        await Promise.race([prev, timeout]);
    } catch (err) {
        // On timeout, release this lock so the queue doesn't deadlock
        releaseLock();
        if (swapOperationLocks.get(swapId) === lockPromise) {
            swapOperationLocks.delete(swapId);
        }
        throw err;
    }

    try {
        return await fn();
    } finally {
        releaseLock();
        if (swapOperationLocks.get(swapId) === lockPromise) {
            swapOperationLocks.delete(swapId);
        }
    }
}

// ---------------------------------------------------------------------------
// IP-based rate limiter (in-memory, no external deps)
// ---------------------------------------------------------------------------

interface IRateLimitBucket {
    count: number;
    resetAt: number;
}

/** Per-endpoint rate limiter. */
class RateLimiter {
    private readonly buckets = new Map<string, IRateLimitBucket>();
    private readonly maxRequests: number;
    private readonly windowMs: number;
    private sweepTimer: NodeJS.Timeout;

    constructor(maxRequests: number, windowMs: number) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        // Periodically sweep expired buckets to prevent memory leak
        this.sweepTimer = setInterval(() => {
            const now = Date.now();
            for (const [key, bucket] of this.buckets) {
                if (now >= bucket.resetAt) this.buckets.delete(key);
            }
        }, windowMs * 2);
        this.sweepTimer.unref(); // Don't block process exit
    }

    /** Returns true if the request is allowed, false if rate-limited. */
    check(ip: string): boolean {
        if (RATE_LIMIT_DISABLED) return true;
        const now = Date.now();
        const bucket = this.buckets.get(ip);
        if (!bucket || now >= bucket.resetAt) {
            this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs });
            return true;
        }
        bucket.count++;
        return bucket.count <= this.maxRequests;
    }
}

/** When true, all per-endpoint rate limiting is disabled (test/dev mode).
 * The production safety check in index.ts calls process.exit(1) before this
 * code runs, but we duplicate the check here for defense-in-depth. */
const RATE_LIMIT_DISABLED = (() => {
    const disabled = (process.env['RATE_LIMIT_DISABLED'] ?? 'false').toLowerCase() === 'true';
    if (disabled) {
        const isProduction = process.env['NODE_ENV'] === 'production' ||
            (process.env['REQUIRE_TLS'] ?? 'false').toLowerCase() === 'true';
        if (isProduction) return false; // Never disable in production
    }
    return disabled;
})();

/** Rate limiters for sensitive endpoints. */
const secretSubmitLimiter = new RateLimiter(10, 60_000);    // 10 req/min per IP
const keySubmitLimiter = new RateLimiter(10, 60_000);       // 10 req/min per IP
export const claimXmrLimiter = new RateLimiter(5, 60_000);  // 5 req/min per IP
const createSwapLimiter = new RateLimiter(5, 60_000);       // 5 req/min per IP
const takeSwapLimiter = new RateLimiter(5, 60_000);         // 5 req/min per IP
const recoverSecretLimiter = new RateLimiter(5, 60_000);    // 5 req/min per IP
const backupSecretLimiter = new RateLimiter(5, 60_000);     // 5 req/min per IP

/** Whether to trust X-Forwarded-For header (only behind a known reverse proxy). */
const TRUST_PROXY = (process.env['TRUST_PROXY'] ?? 'false').toLowerCase() === 'true';

/** Whether mock mode is enabled (cached at module load, not read per-request). */
const IS_MOCK_MODE = (process.env['MONERO_MOCK'] ?? 'false').toLowerCase() === 'true';

/**
 * Extracts client IP from request (X-Forwarded-For only trusted when TRUST_PROXY=true).
 * Uses the RIGHTMOST entry — that's the one set by the trusted reverse proxy.
 * Leftmost is attacker-controlled and trivially spoofable via X-Forwarded-For header.
 */
export function getClientIp(req: IncomingMessage): string {
    if (TRUST_PROXY) {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string') {
            const parts = forwarded.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            const rightmost = parts[parts.length - 1];
            return rightmost ?? 'unknown';
        }
    }
    return req.socket.remoteAddress ?? 'unknown';
}

/** Sends a 429 Too Many Requests response. */
function tooManyRequests(res: ServerResponse): void {
    jsonResponse(res, 429, fail('RATE_LIMITED', 'Too many requests — try again later', true));
}

/** Returns a structured success response. */
function success<T>(data: T): IApiResponse<T> {
    return { success: true, data, error: null };
}

/** Returns a structured error response. */
function fail(code: string, message: string, retryable = false): IApiResponse<never> {
    const error: IApiError = { code, message, retryable };
    return { success: false, data: null, error };
}

const MAX_BODY_BYTES = 65536;

/** Reads and parses the request body as JSON. Enforces Content-Type and maximum body size. */
async function readBody(req: IncomingMessage): Promise<unknown> {
    // Require Content-Type: application/json to prevent CSRF via text/plain forms
    const ct = req.headers['content-type'] ?? '';
    if (!ct.includes('application/json')) {
        return Promise.reject(new Error('Content-Type must be application/json'));
    }
    return new Promise((resolve, reject) => {
        let raw = '';
        let bytesRead = 0;
        let destroyed = false;

        req.on('data', (chunk: Uint8Array | string) => {
            if (destroyed) return;
            const len =
                typeof chunk === 'string'
                    ? new TextEncoder().encode(chunk).byteLength
                    : chunk.length;
            bytesRead += len;
            if (bytesRead > MAX_BODY_BYTES) {
                destroyed = true;
                req.destroy(new Error('Request body too large'));
                reject(new Error('Request body too large'));
                return;
            }
            if (typeof chunk === 'string') {
                raw += chunk;
            } else if (chunk instanceof Uint8Array) {
                raw += new TextDecoder().decode(chunk);
            }
        });
        req.on('end', () => {
            if (destroyed) return;
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/** Sends a JSON response with the given status code. */
function jsonResponse<T>(res: ServerResponse, statusCode: number, body: IApiResponse<T>): void {
    const json = JSON.stringify(body);
    const encoded = new TextEncoder().encode(json);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': encoded.byteLength,
    });
    res.end(json);
}

/** Extracts pagination params from URL query string. */
function parsePagination(url: URL): IPaginationParams {
    const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
    const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));
    return { page, limit };
}

/**
 * Strips sensitive fields (preimage) from a swap record before sending to clients.
 * The preimage is ONLY delivered via WebSocket, never via HTTP.
 */
function sanitizeSwapForApi(swap: ISwapRecord): Record<string, unknown> {
    return {
        ...swap,
        preimage: null,
        claim_token: null,
        alice_view_key: null,
        bob_view_key: null,
        bob_spend_key: null,
        recovery_token: null,
        // Strip Alice's XMR payout address from public API — it links her Bitcoin identity
        // to her Monero address, breaking cross-chain privacy. Only exposed via authenticated
        // endpoints (my-secret, admin).
        alice_xmr_payout: null,
        bob_xmr_refund: null,
        // DLEQ proofs and secp256k1 pubkeys are zero-knowledge proofs, NOT secrets.
        // They MUST be exposed so the counterparty can verify cross-curve key binding.
        // alice_dleq_proof, bob_dleq_proof, alice_secp256k1_pub, bob_secp256k1_pub: kept as-is
    };
}

/** Handler: GET /api/health — accepts optional wallet health checker. */
export function handleHealth(_req: IncomingMessage, res: ServerResponse, walletHealthCheck?: () => boolean): void {
    const walletHealthy = walletHealthCheck ? walletHealthCheck() : true;
    jsonResponse(res, 200, success({
        status: walletHealthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        walletHealthy,
    }));
}

/** Handler: GET /api/swaps */
export function handleListSwaps(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
): void {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const { page, limit } = parsePagination(url);
    const swaps = storage.listSwaps(page, limit);
    const sanitized = swaps.map(sanitizeSwapForApi);
    jsonResponse(res, 200, success({ swaps: sanitized, page, limit }));
}

/** Handler: GET /api/swaps/by-hashlock/:hashLockHex */
export function handleGetSwapByHashLock(
    _req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    hashLockHex: string,
): void {
    if (!/^[0-9a-f]{64}$/i.test(hashLockHex)) {
        jsonResponse(res, 400, fail('VALIDATION', 'hashLockHex must be exactly 64 hex characters'));
        return;
    }
    const swap = storage.getSwapByHashLock(hashLockHex.toLowerCase());
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', 'No swap found with this hash lock'));
        return;
    }
    jsonResponse(res, 200, success({ swap_id: swap.swap_id }));
}

/** Handler: GET /api/swaps/by-claim-token/:claimTokenHex */
export function handleGetSwapByClaimToken(
    _req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    claimTokenHex: string,
): void {
    if (!/^[0-9a-f]{64}$/i.test(claimTokenHex)) {
        jsonResponse(res, 400, fail('VALIDATION', 'claimTokenHex must be exactly 64 hex characters'));
        return;
    }
    const swap = storage.getSwapByClaimToken(claimTokenHex.toLowerCase());
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', 'No swap found with this claim token'));
        return;
    }
    jsonResponse(res, 200, success({ swap_id: swap.swap_id }));
}

/** Handler: GET /api/swaps/:id */
export function handleGetSwap(
    _req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
    getQueuePosition?: (swapId: string) => { position: number; total: number } | null,
): void {
    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
        return;
    }
    const history = storage.getStateHistory(swapId);
    const queuePos = getQueuePosition?.(swapId) ?? null;
    jsonResponse(res, 200, success({
        swap: sanitizeSwapForApi(swap),
        history,
        ...(queuePos ? { sweepQueuePosition: queuePos.position, sweepQueueTotal: queuePos.total } : {}),
    }));
}

/**
 * Handler: POST /api/swaps/:id/take
 *
 * Accepts only { opnetTxId: string }.
 * The actual counterparty address is authoritative from the on-chain watcher,
 * not from the caller — preventing self-reported counterparty spoofing.
 */
export async function handleTakeSwap(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
    stateMachine: SwapStateMachine,
    wsServer: SwapWebSocketServer,
): Promise<void> {
    if (!takeSwapLimiter.check(getClientIp(req))) { tooManyRequests(res); return; }
    // Per-swap lock prevents TOCTOU race: two concurrent take requests
    // can no longer both pass the claim_token check simultaneously.
    return withSwapLock(swapId, async () => {
        const swap = storage.getSwap(swapId);
        if (!swap) {
            jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
            return;
        }

        // Allow take when OPEN, TAKE_PENDING, TAKEN, XMR_LOCKING, or XMR_LOCKED.
        // The OPNet watcher may transition to TAKEN and startXmrLocking may progress
        // to XMR_LOCKING/XMR_LOCKED before Bob's POST /take arrives (race condition).
        // The double-take guard below prevents multiple claim_token assignments.
        const TAKE_ALLOWED_STATES: ReadonlySet<SwapStatus> = new Set([
            SwapStatus.OPEN,
            SwapStatus.TAKE_PENDING,
            SwapStatus.TAKEN,
            SwapStatus.XMR_LOCKING,
            SwapStatus.XMR_LOCKED,
        ]);
        if (!TAKE_ALLOWED_STATES.has(swap.status)) {
            jsonResponse(res, 409, fail('INVALID_STATE', `Swap cannot be taken (current: ${swap.status})`));
            return;
        }

        // Prevent double-take: reject if claim_token already assigned
        if (swap.claim_token && swap.claim_token.length > 0) {
            jsonResponse(res, 409, fail('ALREADY_TAKEN', 'Swap has already been taken'));
            return;
        }

        let body: ITakeSwapBody;
        try {
            const parsed = await readBody(req);
            if (
                typeof parsed !== 'object' ||
                parsed === null ||
                !('opnetTxId' in parsed) ||
                typeof (parsed as { opnetTxId: unknown }).opnetTxId !== 'string'
            ) {
                jsonResponse(res, 400, fail('VALIDATION', 'opnetTxId (string) is required'));
                return;
            }
            body = parsed as ITakeSwapBody;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Invalid request';
            jsonResponse(res, 400, fail('INVALID_BODY', msg));
            return;
        }

        if (!body.opnetTxId || body.opnetTxId.trim().length === 0) {
            jsonResponse(res, 400, fail('VALIDATION', 'opnetTxId must not be empty'));
            return;
        }

        // Re-check under lock (defense-in-depth)
        const freshSwap = storage.getSwap(swapId);
        if (freshSwap && freshSwap.claim_token && freshSwap.claim_token.length > 0) {
            jsonResponse(res, 409, fail('ALREADY_TAKEN', 'Swap has already been taken'));
            return;
        }

        // Require claimTokenHint: deterministically derived from Bob's mnemonic via HKDF.
        // This is 256-bit entropy — an attacker cannot guess it without the mnemonic.
        // Always required — no random fallback. This ensures Bob can recover the swap.
        const hint = typeof (body as unknown as Record<string, unknown>)['claimTokenHint'] === 'string'
            ? ((body as unknown as Record<string, unknown>)['claimTokenHint'] as string).trim().toLowerCase()
            : null;
        if (!hint || !/^[0-9a-f]{64}$/.test(hint)) {
            jsonResponse(res, 400, fail('VALIDATION', 'claimTokenHint (64 hex chars, from mnemonic) is required'));
            return;
        }
        const claimToken = hint;

        // Optional: Bob's XMR refund address (where expired swap XMR is returned)
        const rawBobRefund = typeof (body as unknown as Record<string, unknown>)['bobXmrRefund'] === 'string'
            ? ((body as unknown as Record<string, unknown>)['bobXmrRefund'] as string).trim()
            : null;
        let bobXmrRefund: string | null = null;
        if (rawBobRefund && rawBobRefund.length > 0) {
            const addrErr = validateMoneroAddress(rawBobRefund);
            if (addrErr) {
                jsonResponse(res, 400, fail('VALIDATION', `Invalid bobXmrRefund address: ${addrErr}`));
                return;
            }
            bobXmrRefund = rawBobRefund;
        }

        const currentSwap = freshSwap ?? swap;
        const wasOpen = currentSwap.status === SwapStatus.OPEN;

        // If swap is OPEN, transition to TAKE_PENDING (reservation).
        // Bob must POST /keys to advance to TAKEN. 60s timeout reverts to OPEN.
        if (wasOpen) {
            const counterparty = body.opnetTxId.trim().replace(/[^0-9a-fA-F]/g, '').slice(0, 64);
            // Validate counterparty is a proper 64-char hex transaction ID.
            if (counterparty.length !== 64) {
                jsonResponse(res, 400, fail('VALIDATION', 'opnetTxId must be a valid 64-character hex transaction hash'));
                return;
            }
            // Validate transition BEFORE writing, using a synthetic swap with updated fields.
            const syntheticSwap = { ...currentSwap, counterparty, claim_token: claimToken } as ISwapRecord;
            try {
                stateMachine.validate(syntheticSwap, SwapStatus.TAKE_PENDING);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Invalid transition';
                jsonResponse(res, 409, fail('INVALID_TRANSITION', msg));
                return;
            }
            // Atomic write: claim_token + counterparty + status + take_pending_at in one UPDATE.
            const takeFields: IUpdateSwapParams = {
                claim_token: claimToken,
                counterparty,
                status: SwapStatus.TAKE_PENDING,
                take_pending_at: new Date().toISOString(),
                ...(bobXmrRefund ? { bob_xmr_refund: bobXmrRefund } : {}),
            };
            storage.updateSwap(swapId, takeFields, SwapStatus.OPEN, 'Swap take pending');
        } else {
            storage.updateSwap(swapId, { claim_token: claimToken });
        }

        const updatedSwap = storage.getSwap(swapId);

        // Notify state machine + broadcast if we transitioned
        if (wasOpen && updatedSwap) {
            stateMachine.notifyTransition(updatedSwap, SwapStatus.OPEN, SwapStatus.TAKE_PENDING);
            wsServer.broadcastSwapUpdate(updatedSwap);
        }

        // Return sanitized values only — never reflect raw user input
        const sanitizedTxId = body.opnetTxId.trim().replace(/[^0-9a-fA-F]/g, '').slice(0, 64);
        jsonResponse(res, 200, success({
            swap: sanitizeSwapForApi(updatedSwap ?? currentSwap),
            opnetTxId: sanitizedTxId,
            claim_token: claimToken,
        }));
    });
}

/**
 * Handler: POST /api/swaps/:id/secret
 *
 * Accepts { secret: string } (64-char hex preimage).
 * Validates SHA-256(secret) == hash_lock, then stores in DB.
 * The preimage is ONLY revealed to subscribers via WebSocket.
 */
export async function handleSubmitSecret(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
): Promise<void> {
    if (!secretSubmitLimiter.check(getClientIp(req))) { tooManyRequests(res); return; }
    // Per-swap lock prevents concurrent preimage submissions from both
    // passing the null check before either stores.
    return withSwapLock(swapId, async () => {
        const swap = storage.getSwap(swapId);
        if (!swap) {
            jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
            return;
        }

        // Auth: require recovery_token (issued at swap creation, known only to Alice).
        // This prevents an attacker who intercepts the preimage from setting alice_xmr_payout.
        const recoveryTokenHeader = req.headers['x-recovery-token'];
        if (typeof recoveryTokenHeader !== 'string' || !recoveryTokenHeader) {
            jsonResponse(res, 401, fail('AUTH_REQUIRED', 'X-Recovery-Token header is required'));
            return;
        }
        if (!swap.recovery_token || swap.recovery_token.length === 0) {
            jsonResponse(res, 403, fail('NO_TOKEN', 'No recovery token set for this swap'));
            return;
        }
        if (!safeTokenCompare(swap.recovery_token, recoveryTokenHeader)) {
            jsonResponse(res, 403, fail('FORBIDDEN', 'Invalid recovery token'));
            console.log(`[Routes] Rejected secret submission for swap ${swapId} — invalid recovery_token`);
            return;
        }

        // Accept secrets for OPEN (Alice submits right after creation), TAKEN (normal flow),
        // and later pre-claim states (idempotent re-submission).
        const ACCEPT_SECRET_STATES = new Set([
            SwapStatus.OPEN,
            SwapStatus.TAKEN,
            SwapStatus.XMR_LOCKING,
            SwapStatus.XMR_LOCKED,
        ]);
        if (!ACCEPT_SECRET_STATES.has(swap.status)) {
            jsonResponse(
                res,
                409,
                fail('INVALID_STATE', `Swap is in state ${swap.status} — cannot accept secret`),
            );
            return;
        }

        let secret: string;
        let aliceViewKey: string | undefined;
        let aliceXmrPayout: string | undefined;
        let aliceSecp256k1Pub: string | undefined;
        let aliceDleqProof: string | undefined;
        try {
            const parsed = await readBody(req);
            if (
                typeof parsed !== 'object' ||
                parsed === null ||
                !('secret' in parsed) ||
                typeof (parsed as { secret: unknown }).secret !== 'string'
            ) {
                jsonResponse(res, 400, fail('VALIDATION', 'secret (string) is required'));
                return;
            }
            secret = (parsed as { secret: string }).secret.trim().toLowerCase();
            const candidate = parsed as Record<string, unknown>;
            if (typeof candidate['aliceViewKey'] === 'string') {
                aliceViewKey = candidate['aliceViewKey'].trim().toLowerCase();
            }
            if (typeof candidate['aliceXmrPayout'] === 'string' && candidate['aliceXmrPayout'].length > 0) {
                aliceXmrPayout = candidate['aliceXmrPayout'].trim();
                const addrErr = validateMoneroAddress(aliceXmrPayout);
                if (addrErr !== null) {
                    jsonResponse(res, 400, fail('VALIDATION', `Invalid aliceXmrPayout address: ${addrErr}`));
                    return;
                }
            }
            if (typeof candidate['aliceSecp256k1Pub'] === 'string') {
                aliceSecp256k1Pub = candidate['aliceSecp256k1Pub'].trim().toLowerCase();
            }
            if (typeof candidate['aliceDleqProof'] === 'string') {
                aliceDleqProof = candidate['aliceDleqProof'].trim().toLowerCase();
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Invalid request';
            jsonResponse(res, 400, fail('INVALID_BODY', msg));
            return;
        }

        if (!/^[0-9a-f]{64}$/.test(secret)) {
            jsonResponse(res, 400, fail('VALIDATION', 'Secret must be exactly 64 hex characters'));
            return;
        }

        if (aliceViewKey !== undefined && !/^[0-9a-f]{64}$/.test(aliceViewKey)) {
            jsonResponse(res, 400, fail('VALIDATION', 'aliceViewKey must be exactly 64 hex characters'));
            return;
        }

        // Validate Alice's view key produces a non-degenerate ed25519 point.
        // A malicious Alice could submit a view key that, when combined with Bob's,
        // makes the shared address unscannable (coordinator misses XMR deposit).
        if (aliceViewKey !== undefined) {
            const viewKeyErr = validateViewKeyScalar(hexToBytes(aliceViewKey));
            if (viewKeyErr !== null) {
                jsonResponse(res, 400, fail('VALIDATION', `Invalid aliceViewKey: ${viewKeyErr}`));
                return;
            }
        }

        if (!verifyPreimage(secret, swap.hash_lock)) {
            jsonResponse(
                res,
                400,
                fail('HASH_MISMATCH', 'SHA-256(secret) does not match the swap hash lock'),
            );
            return;
        }

        // Re-check preimage under lock (defense-in-depth)
        const freshSwap = storage.getSwap(swapId);
        if (freshSwap && freshSwap.preimage !== null && freshSwap.preimage.length > 0) {
            const storedBuf = Buffer.from(freshSwap.preimage, 'utf-8');
            const secretBuf = Buffer.from(secret, 'utf-8');
            if (storedBuf.length === secretBuf.length && timingSafeEqual(storedBuf, secretBuf)) {
                // Preimage matches — but still enforce payout address lock before returning
                if (aliceXmrPayout && freshSwap.alice_xmr_payout && freshSwap.alice_xmr_payout.length > 0
                    && freshSwap.alice_xmr_payout !== aliceXmrPayout) {
                    jsonResponse(res, 409, fail('PAYOUT_LOCKED', 'Alice XMR payout address already set and cannot be changed'));
                    return;
                }
                jsonResponse(res, 200, success({ stored: true, trustless: freshSwap.trustless_mode === 1 }));
                return;
            }
            jsonResponse(res, 409, fail('ALREADY_SET', 'A different preimage is already stored for this swap'));
            return;
        }

        const updateParams: Record<string, string | number | null> = { preimage: secret };

        if (aliceViewKey) {
            const secretBytes = hexToBytes(secret);
            const alicePub = ed25519PublicFromPrivate(secretBytes);
            const alicePubHex = bytesToHex(alicePub);
            updateParams['trustless_mode'] = 1;
            updateParams['alice_ed25519_pub'] = alicePubHex;
            updateParams['alice_view_key'] = aliceViewKey;
            console.log(`[Routes] Split-key mode enabled for swap ${swapId}`);

            // Cross-curve DLEQ proof verification (if provided)
            if (aliceSecp256k1Pub && aliceDleqProof) {
                if (!/^[0-9a-f]{66}$/.test(aliceSecp256k1Pub)) {
                    jsonResponse(res, 400, fail('VALIDATION', 'aliceSecp256k1Pub must be exactly 66 hex characters (33 bytes compressed)'));
                    return;
                }
                if (!/^[0-9a-f]{192}$/.test(aliceDleqProof)) {
                    jsonResponse(res, 400, fail('VALIDATION', 'aliceDleqProof must be exactly 192 hex characters (96 bytes)'));
                    return;
                }
                const edPubBytes = hexToBytes(alicePubHex);
                const secPubBytes = hexToBytes(aliceSecp256k1Pub);
                const proofBytes = hexToBytes(aliceDleqProof);
                if (!verifyCrossCurveDleq(edPubBytes, secPubBytes, proofBytes, swap.hash_lock)) {
                    jsonResponse(res, 400, fail('DLEQ_INVALID', 'Alice cross-curve DLEQ proof verification failed'));
                    return;
                }
                updateParams['alice_secp256k1_pub'] = aliceSecp256k1Pub;
                updateParams['alice_dleq_proof'] = aliceDleqProof;
                console.log(`[Routes] Alice DLEQ proof verified for swap ${swapId}`);
            } else if (isDleqRequired()) {
                jsonResponse(res, 400, fail('DLEQ_REQUIRED', 'DLEQ proof is required — provide aliceSecp256k1Pub and aliceDleqProof'));
                return;
            }
        }

        if (aliceXmrPayout) {
            // Prevent overwriting an existing payout address with a different one
            // (blocks attacker who intercepts preimage from redirecting XMR)
            if (freshSwap && freshSwap.alice_xmr_payout && freshSwap.alice_xmr_payout.length > 0
                && freshSwap.alice_xmr_payout !== aliceXmrPayout) {
                jsonResponse(res, 409, fail('PAYOUT_LOCKED', 'Alice XMR payout address already set and cannot be changed'));
                return;
            }
            updateParams['alice_xmr_payout'] = aliceXmrPayout;
            console.log(`[Routes] Alice XMR payout address set for swap ${swapId}: ${aliceXmrPayout.slice(0, 12)}...`);
        }

        storage.updateSwap(swapId, updateParams as import('../types.js').IUpdateSwapParams);
        log.info('Secret stored', swapId);

        jsonResponse(res, 200, success({ stored: true, trustless: !!aliceViewKey }));
    });
}

/** Handler: POST /api/swaps (create a new swap record — coordinator internal use) */
/** Minimum number of blocks a swap HTLC must have until refund (prevents too-tight timelocks). */
const MIN_HTLC_BLOCKS_REMAINING = 100;

export async function handleCreateSwap(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    currentBlock?: bigint,
): Promise<void> {
    if (!createSwapLimiter.check(getClientIp(req))) { tooManyRequests(res); return; }
    let body: ICreateSwapParams;
    try {
        const parsed = await readBody(req);
        if (typeof parsed !== 'object' || parsed === null) {
            jsonResponse(res, 400, fail('VALIDATION', 'Request body must be a JSON object'));
            return;
        }
        const candidate = parsed as Record<string, unknown>;
        if (
            typeof candidate['swap_id'] !== 'string' ||
            typeof candidate['hash_lock'] !== 'string' ||
            typeof candidate['refund_block'] !== 'number' ||
            typeof candidate['moto_amount'] !== 'string' ||
            typeof candidate['xmr_amount'] !== 'string' ||
            typeof candidate['depositor'] !== 'string'
        ) {
            jsonResponse(
                res,
                400,
                fail(
                    'VALIDATION',
                    'Required fields: swap_id, hash_lock, refund_block, moto_amount, xmr_amount, depositor',
                ),
            );
            return;
        }
        // Extract validated fields (types already checked above)
        const swapId = candidate['swap_id'];
        const hashLock = candidate['hash_lock'];
        const refundBlock = candidate['refund_block'];
        const motoAmount = candidate['moto_amount'];
        const xmrAmount = candidate['xmr_amount'];
        const depositorAddr = candidate['depositor'];

        // Validate hash_lock format: exactly 64 hex characters
        if (!/^[0-9a-f]{64}$/i.test(hashLock)) {
            jsonResponse(res, 400, fail('VALIDATION', 'hash_lock must be exactly 64 hex characters'));
            return;
        }

        // Validate swap_id format: numeric string (on-chain swap ID is a uint256)
        if (!/^[0-9]+$/.test(swapId) || swapId.length > 78) {
            jsonResponse(res, 400, fail('VALIDATION', 'swap_id must be a numeric string'));
            return;
        }

        // Validate amount strings are valid non-negative integers
        const xmrParsed = safeParseAmount(xmrAmount);
        if (xmrParsed === null || xmrParsed <= 0n) {
            jsonResponse(res, 400, fail('VALIDATION', 'xmr_amount must be a positive integer string'));
            return;
        }
        const motoParsed = safeParseAmount(motoAmount);
        if (motoParsed === null || motoParsed <= 0n) {
            jsonResponse(res, 400, fail('VALIDATION', 'moto_amount must be a positive integer string'));
            return;
        }
        if (xmrParsed < MIN_XMR_AMOUNT_PICONERO) {
            jsonResponse(res, 400, fail('VALIDATION', `xmr_amount below minimum (${MIN_XMR_AMOUNT_PICONERO} piconero = 0.025 XMR)`));
            return;
        }
        // Reject amounts that would overflow Number.MAX_SAFE_INTEGER at sweep time
        // (wallet-rpc JSON-RPC uses JSON integers which lose precision above 2^53-1)
        const MAX_XMR_AMOUNT_PICONERO = BigInt(Number.MAX_SAFE_INTEGER); // ~9,007 XMR
        if (xmrParsed > MAX_XMR_AMOUNT_PICONERO) {
            jsonResponse(res, 400, fail('VALIDATION', `xmr_amount exceeds maximum safe amount (~9,007 XMR)`));
            return;
        }
        // Validate refund_block is positive
        if (refundBlock <= 0) {
            jsonResponse(res, 400, fail('VALIDATION', 'refund_block must be a positive number'));
            return;
        }
        // Ensure HTLC timelock is far enough in the future for the swap to complete
        if (currentBlock && currentBlock > 0n) {
            const blocksRemaining = BigInt(refundBlock) - currentBlock;
            if (blocksRemaining < BigInt(MIN_HTLC_BLOCKS_REMAINING)) {
                jsonResponse(res, 400, fail(
                    'VALIDATION',
                    `refund_block is too close to current block (${blocksRemaining} blocks remaining, need ≥${MIN_HTLC_BLOCKS_REMAINING}). ` +
                    `The swap would likely expire before XMR can be locked and confirmed.`,
                ));
                return;
            }
        }

        // Optional: Alice's XMR payout address (where she receives XMR after completion)
        let aliceXmrPayout: string | null = null;
        if (typeof candidate['alice_xmr_payout'] === 'string' && candidate['alice_xmr_payout'].length > 0) {
            aliceXmrPayout = candidate['alice_xmr_payout'].trim();
            const addrErr = validateMoneroAddress(aliceXmrPayout);
            if (addrErr !== null) {
                jsonResponse(res, 400, fail('VALIDATION', `Invalid alice_xmr_payout: ${addrErr}`));
                return;
            }
        }

        body = {
            swap_id: swapId,
            hash_lock: hashLock,
            refund_block: refundBlock,
            moto_amount: motoAmount,
            xmr_amount: xmrAmount,
            xmr_fee: calculateXmrFee(xmrAmount),
            xmr_total: calculateXmrTotal(xmrAmount),
            xmr_address: null, // Never accept user-supplied xmr_address — coordinator generates it
            depositor: depositorAddr,
            opnet_create_tx:
                typeof candidate['opnet_create_tx'] === 'string' &&
                /^[0-9a-f]{64}$/i.test(candidate['opnet_create_tx'])
                    ? candidate['opnet_create_tx']
                    : null,
            alice_xmr_payout: aliceXmrPayout,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    const existing = storage.getSwap(body.swap_id);
    if (existing) {
        jsonResponse(res, 409, fail('CONFLICT', `Swap ${body.swap_id} already exists`));
        return;
    }

    try {
        const created = storage.createSwap(body);

        // Use deterministic recovery_token from backup if available (Alice derived it from mnemonic).
        // Fall back to random token for backward compatibility (e.g., admin-created swaps).
        const backup = storage.getSecretBackup(body.hash_lock);
        const recoveryToken = (backup?.recoveryToken && /^[0-9a-f]{64}$/.test(backup.recoveryToken))
            ? backup.recoveryToken
            : randomBytes(32).toString('hex');
        storage.updateSwap(body.swap_id, { recovery_token: recoveryToken });
        const withToken = storage.getSwap(body.swap_id);
        jsonResponse(res, 201, success({ ...sanitizeSwapForApi(withToken ?? created), recovery_token: recoveryToken }));
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Storage error';
        jsonResponse(res, 500, fail('STORAGE_ERROR', message, true));
    }
}

/** Handler: GET /api/fee-address — returns the current XMR fee wallet address. */
export function handleGetFeeAddress(_req: IncomingMessage, res: ServerResponse): void {
    jsonResponse(res, 200, success({ feeAddress: getFeeAddress(), feeBps: 87 }));
}

/** Handler: PUT /api/fee-address — updates the XMR fee wallet address. */
export async function handleSetFeeAddress(
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    let address: string;
    try {
        const parsed = await readBody(req);
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !('address' in parsed) ||
            typeof (parsed as { address: unknown }).address !== 'string'
        ) {
            jsonResponse(res, 400, fail('VALIDATION', 'address (string) is required'));
            return;
        }
        address = (parsed as { address: string }).address;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    try {
        setFeeAddress(address);
        jsonResponse(res, 200, success({ feeAddress: getFeeAddress(), feeBps: 87 }));
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Validation error';
        jsonResponse(res, 400, fail('VALIDATION', message));
    }
}

/**
 * Handler: POST /api/swaps/:id/keys
 *
 * Accepts Bob's key material for split-key mode:
 *   { bobEd25519PubKey: string, bobViewKey: string, bobKeyProof: string }
 *
 * The swap must already be in split-key mode (Alice submitted aliceViewKey with secret).
 * Once Bob's keys are stored, the coordinator can compute the shared Monero address.
 * NOTE: The coordinator holds both key shares and is trusted with the XMR side.
 */
export async function handleSubmitKeys(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
    stateMachine?: import('../state-machine.js').SwapStateMachine,
    wsServer?: import('../websocket.js').SwapWebSocketServer,
): Promise<void> {
    if (!keySubmitLimiter.check(getClientIp(req))) { tooManyRequests(res); return; }
    // Per-swap lock prevents concurrent key submissions from racing
    return withSwapLock(swapId, async () => {
    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
        return;
    }

    // If the DB has a claim_token, verify it matches (handled below in claimToken validation).
    // If no claim_token in DB (e.g., swap imported from on-chain after DB wipe), allow keys
    // since the swap is already TAKEN on-chain. This mirrors the WebSocket auth logic.

    // Must be in split-key mode. For on-chain imported swaps (no claim_token),
    // trustless_mode may not be set yet — skip this check and set it during key storage.
    const isOnChainImport = !swap.claim_token || swap.claim_token.length === 0;
    if (swap.trustless_mode !== 1 && !isOnChainImport) {
        jsonResponse(res, 409, fail('NOT_TRUSTLESS', 'Swap is not in split-key mode — Alice must submit aliceViewKey with secret first'));
        return;
    }

    // Accept keys when swap is TAKE_PENDING, TAKEN, or later pre-claim states
    const ACCEPT_KEYS_STATES = new Set([
        SwapStatus.TAKE_PENDING,
        SwapStatus.TAKEN,
        SwapStatus.XMR_LOCKING,
        SwapStatus.XMR_LOCKED,
        SwapStatus.XMR_SWEEPING,
    ]);
    if (!ACCEPT_KEYS_STATES.has(swap.status)) {
        jsonResponse(res, 409, fail('INVALID_STATE', `Swap is in state ${swap.status} — cannot accept keys`));
        return;
    }

    // Reject if Bob's keys are already set
    if (swap.bob_ed25519_pub && swap.bob_ed25519_pub.length > 0) {
        jsonResponse(res, 200, success({ stored: true, message: 'Bob keys already stored' }));
        return;
    }

    let bobPub: string;
    let bobViewKey: string;
    let bobKeyProof: string;
    let bobSpendKey: string | undefined;
    let claimToken: string | undefined;
    let bobSecp256k1Pub: string | undefined;
    let bobDleqProof: string | undefined;
    try {
        const parsed = await readBody(req);
        const candidate = parsed as Record<string, unknown>;
        if (
            typeof candidate['bobEd25519PubKey'] !== 'string' ||
            typeof candidate['bobViewKey'] !== 'string' ||
            typeof candidate['bobKeyProof'] !== 'string'
        ) {
            jsonResponse(res, 400, fail('VALIDATION', 'Required: bobEd25519PubKey, bobViewKey, bobKeyProof (all hex strings)'));
            return;
        }
        bobPub = candidate['bobEd25519PubKey'].trim().toLowerCase();
        bobViewKey = candidate['bobViewKey'].trim().toLowerCase();
        bobKeyProof = candidate['bobKeyProof'].trim().toLowerCase();
        // Optional: Bob's private spend key (needed for coordinator to sweep XMR after completion)
        if (typeof candidate['bobSpendKey'] === 'string') {
            bobSpendKey = candidate['bobSpendKey'].trim().toLowerCase();
        }
        if (typeof candidate['claimToken'] === 'string') {
            claimToken = candidate['claimToken'];
        }
        if (typeof candidate['bobSecp256k1Pub'] === 'string') {
            bobSecp256k1Pub = candidate['bobSecp256k1Pub'].trim().toLowerCase();
        }
        if (typeof candidate['bobDleqProof'] === 'string') {
            bobDleqProof = candidate['bobDleqProof'].trim().toLowerCase();
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    // If the DB has a claim_token, require and verify it.
    // If the DB has NO claim_token (swap imported from on-chain after watcher sync),
    // allow key submission without token — the on-chain TAKEN status is authorization.
    if (swap.claim_token && swap.claim_token.length > 0) {
        if (!claimToken) {
            jsonResponse(res, 401, fail('AUTH_REQUIRED', 'claimToken is required for key submission'));
            return;
        }
        if (!/^[0-9a-f]{64}$/.test(claimToken)) {
            jsonResponse(res, 400, fail('VALIDATION', 'claimToken must be exactly 64 hex characters'));
            return;
        }
        if (!safeTokenCompare(swap.claim_token, claimToken)) {
            jsonResponse(res, 401, fail('AUTH_FAILED', 'Invalid claim token'));
            console.log(`[Routes] Rejected key submission for swap ${swapId} — invalid claim_token`);
            return;
        }
    } else {
        // No claim_token in DB — swap was imported from on-chain. Allow key submission.
        console.log(`[Routes] Swap ${swapId}: accepting keys without claim_token (on-chain imported swap)`);
    }

    // Validate formats
    if (!/^[0-9a-f]{64}$/.test(bobPub)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobEd25519PubKey must be exactly 64 hex characters'));
        return;
    }
    if (!/^[0-9a-f]{64}$/.test(bobViewKey)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobViewKey must be exactly 64 hex characters'));
        return;
    }
    // Validate Bob's view key produces a non-degenerate ed25519 point.
    // A malicious Bob could submit a view key that, when combined with Alice's,
    // makes the shared address unscannable or predictable.
    {
        const viewKeyErr = validateViewKeyScalar(hexToBytes(bobViewKey));
        if (viewKeyErr !== null) {
            jsonResponse(res, 400, fail('VALIDATION', `Invalid bobViewKey: ${viewKeyErr}`));
            return;
        }
    }
    // Key proof must be exactly 128 hex chars (64 bytes: R || s)
    if (!/^[0-9a-f]{128}$/.test(bobKeyProof)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobKeyProof must be exactly 128 hex characters (64 bytes)'));
        return;
    }

    // Validate bobSpendKey if provided
    if (bobSpendKey !== undefined && !/^[0-9a-f]{64}$/.test(bobSpendKey)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobSpendKey must be exactly 64 hex characters'));
        return;
    }
    // Validate DLEQ-related fields early (before combined check) to reject malformed inputs
    if (bobSecp256k1Pub !== undefined && !/^[0-9a-f]{66}$/.test(bobSecp256k1Pub)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobSecp256k1Pub must be exactly 66 hex characters (33 bytes compressed)'));
        return;
    }
    if (bobDleqProof !== undefined && !/^[0-9a-f]{192}$/.test(bobDleqProof)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobDleqProof must be exactly 192 hex characters (96 bytes)'));
        return;
    }

    // Verify Bob's proof-of-knowledge: proves he knows the private key behind bobPub
    const proofBytes = hexToBytes(bobKeyProof);
    const pubBytes = hexToBytes(bobPub);
    if (!verifyBobKeyProof(pubBytes, proofBytes, swapId)) {
        jsonResponse(res, 400, fail('KEY_PROOF_INVALID', 'Bob key proof-of-knowledge verification failed — cannot prove ownership of submitted public key'));
        return;
    }

    // Verify bobSpendKey matches bobPub (if provided).
    // Without this check, a griefing attacker could submit an arbitrary spend key,
    // causing the coordinator to reconstruct the wrong combined key and permanently lock XMR.
    if (bobSpendKey !== undefined) {
        const spendKeyBytes = hexToBytes(bobSpendKey);
        const derivedPub = ed25519PublicFromPrivate(spendKeyBytes);
        const derivedPubHex = bytesToHex(derivedPub);
        if (derivedPubHex !== bobPub) {
            jsonResponse(res, 400, fail('SPEND_KEY_MISMATCH', 'bobSpendKey does not correspond to bobEd25519PubKey — derived public key does not match'));
            return;
        }
    }

    // Cross-curve DLEQ proof verification (if provided)
    const updateFields: Record<string, string | number | null> = {
        bob_ed25519_pub: bobPub,
        bob_view_key: bobViewKey,
    };
    // For on-chain imported swaps, set trustless_mode if not already set
    if (isOnChainImport && swap.trustless_mode !== 1) {
        updateFields['trustless_mode'] = 1;
    }
    if (bobSpendKey !== undefined) {
        updateFields['bob_spend_key'] = bobSpendKey;
    }

    if (bobSecp256k1Pub && bobDleqProof) {
        // Hex format already validated above (lines 940-947)
        const bobEdPubBytes = hexToBytes(bobPub);
        const bobSecPubBytes = hexToBytes(bobSecp256k1Pub);
        const dleqProofBytes = hexToBytes(bobDleqProof);
        if (!verifyCrossCurveDleq(bobEdPubBytes, bobSecPubBytes, dleqProofBytes, swap.hash_lock)) {
            jsonResponse(res, 400, fail('DLEQ_INVALID', 'Bob cross-curve DLEQ proof verification failed'));
            return;
        }
        updateFields['bob_secp256k1_pub'] = bobSecp256k1Pub;
        updateFields['bob_dleq_proof'] = bobDleqProof;
        console.log(`[Routes] Bob DLEQ proof verified and stored for swap ${swapId}`);
    } else if (isDleqRequired()) {
        jsonResponse(res, 400, fail('DLEQ_REQUIRED', 'DLEQ proof is required — provide bobSecp256k1Pub and bobDleqProof'));
        return;
    }

    storage.updateSwap(swapId, updateFields as import('../types.js').IUpdateSwapParams);
    log.info('Bob keys verified and stored', swapId);

    // Auto-advance TAKE_PENDING → TAKEN now that Bob's keys are validated
    if (swap.status === SwapStatus.TAKE_PENDING && stateMachine) {
        try {
            stateMachine.validate(swap, SwapStatus.TAKEN);
            const updated = storage.updateSwap(
                swapId,
                { status: SwapStatus.TAKEN, take_pending_at: null },
                SwapStatus.TAKE_PENDING,
                'TAKE_PENDING → TAKEN: Bob keys validated',
            );
            stateMachine.notifyTransition(updated, SwapStatus.TAKE_PENDING, SwapStatus.TAKEN);
            if (wsServer) wsServer.broadcastSwapUpdate(updated);
            log.info('Auto-advanced TAKE_PENDING → TAKEN after key validation', swapId);
        } catch (advanceErr: unknown) {
            const msg = advanceErr instanceof Error ? advanceErr.message : String(advanceErr);
            log.warn(`Failed to auto-advance TAKE_PENDING → TAKEN: ${msg}`, swapId);
        }
    }

    jsonResponse(res, 200, success({ stored: true }));
    });
}

/**
 * Handler: PUT /api/admin/swaps/:id
 *
 * Test-only endpoint gated by MONERO_MOCK=true.
 * Allows tests to simulate on-chain state changes (OPEN → TAKEN, etc.)
 * without the OPNet watcher. Validates transitions via the state machine.
 */
export async function handleAdminUpdateSwap(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    stateMachine: SwapStateMachine,
    wsServer: SwapWebSocketServer,
    swapId: string,
): Promise<void> {
    // Gate: only available when MONERO_MOCK=true (cached at module load, not per-request)
    if (!IS_MOCK_MODE) {
        jsonResponse(res, 403, fail('FORBIDDEN', 'Admin state endpoint is only available in mock mode'));
        return;
    }

    return withSwapLock(swapId, async () => {
    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
        return;
    }

    let updates: Record<string, unknown>;
    try {
        const parsed = await readBody(req);
        if (typeof parsed !== 'object' || parsed === null) {
            jsonResponse(res, 400, fail('VALIDATION', 'Request body must be a JSON object'));
            return;
        }
        updates = parsed as Record<string, unknown>;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    // Build IUpdateSwapParams from the request body
    const updateParams: Record<string, string | number | null | undefined> = {};
    const allowedFields: ReadonlyArray<string> = [
        'status', 'counterparty', 'opnet_claim_tx', 'opnet_refund_tx',
        'xmr_lock_tx', 'xmr_lock_confirmations', 'xmr_address',
        'xmr_subaddr_index', 'preimage', 'claim_token',
        'trustless_mode', 'alice_ed25519_pub', 'alice_view_key',
        'bob_ed25519_pub', 'bob_view_key', 'bob_spend_key',
        'bob_dleq_proof', 'alice_secp256k1_pub', 'alice_dleq_proof',
        'bob_secp256k1_pub', 'alice_xmr_payout', 'sweep_status',
        'xmr_sweep_tx', 'xmr_sweep_confirmations', 'recovery_token',
    ];

    for (const field of allowedFields) {
        if (field in updates) {
            const val = updates[field];
            if (val === null || typeof val === 'string' || typeof val === 'number') {
                updateParams[field] = val;
            }
        }
    }

    // If status change requested, validate the transition
    const newStatus = updateParams['status'];
    if (typeof newStatus === 'string') {
        // Verify it's a valid SwapStatus
        if (!Object.values(SwapStatus).includes(newStatus as SwapStatus)) {
            jsonResponse(res, 400, fail('VALIDATION', `Invalid status: ${newStatus}`));
            return;
        }

        // Apply non-status fields first (guards may need them)
        const preFields: Record<string, string | number | null | undefined> = { ...updateParams };
        delete preFields['status'];
        const preFieldKeys = Object.keys(preFields);

        // Save original values for rollback on validation failure
        let originalValues: Record<string, string | number | null | undefined> | null = null;
        if (preFieldKeys.length > 0) {
            const beforeSwap = storage.getSwap(swapId);
            if (beforeSwap) {
                originalValues = {};
                for (const key of preFieldKeys) {
                    originalValues[key] = (beforeSwap as unknown as Record<string, unknown>)[key] as string | number | null | undefined;
                }
            }
            storage.updateSwap(swapId, preFields as IUpdateSwapParams);
        }

        // Re-fetch after pre-fields applied, then validate transition
        const freshSwap = storage.getSwap(swapId);
        if (!freshSwap) {
            jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found after pre-update`));
            return;
        }

        try {
            stateMachine.validate(freshSwap, newStatus as SwapStatus);
        } catch (err: unknown) {
            // Roll back pre-applied fields on validation failure
            if (originalValues && preFieldKeys.length > 0) {
                storage.updateSwap(swapId, originalValues as unknown as IUpdateSwapParams);
            }
            const msg = err instanceof Error ? err.message : 'Invalid transition';
            jsonResponse(res, 409, fail('INVALID_TRANSITION', msg));
            return;
        }

        // Apply the status change
        const fromState = freshSwap.status;
        const updated = storage.updateSwap(
            swapId,
            { status: newStatus as SwapStatus } as IUpdateSwapParams,
            fromState,
            `Admin state change: ${fromState} → ${newStatus}`,
        );
        stateMachine.notifyTransition(updated, fromState, newStatus as SwapStatus);
        wsServer.broadcastSwapUpdate(updated);

        jsonResponse(res, 200, success({ swap: sanitizeSwapForApi(updated) }));
        return;
    }

    // No status change — just apply field updates
    if (Object.keys(updateParams).length === 0) {
        jsonResponse(res, 400, fail('VALIDATION', 'No valid update fields provided'));
        return;
    }

    const updated = storage.updateSwap(swapId, updateParams as IUpdateSwapParams);
    wsServer.broadcastSwapUpdate(updated);
    jsonResponse(res, 200, success({ swap: sanitizeSwapForApi(updated) }));
    }); // end withSwapLock
}

/**
 * Handler: POST /api/admin/swaps/:id/recover
 * Production-safe admin recovery endpoint for unsticking swaps.
 * Actions: force_expire, retry_sweep, force_refund, scrub_secrets
 */
export async function handleAdminRecover(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    stateMachine: SwapStateMachine,
    wsServer: SwapWebSocketServer,
    _sweepQueue: import('../sweep-queue.js').SweepQueue,
    swapId: string,
    _operatorXmrAddress: string | null,
): Promise<void> {
    return withSwapLock(swapId, async () => {
    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
        return;
    }

    let body: Record<string, unknown>;
    try {
        const parsed = await readBody(req);
        if (typeof parsed !== 'object' || parsed === null) {
            jsonResponse(res, 400, fail('VALIDATION', 'Request body must be a JSON object'));
            return;
        }
        body = parsed as Record<string, unknown>;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    const action = body['action'];
    if (typeof action !== 'string') {
        jsonResponse(res, 400, fail('VALIDATION', 'Required: action (force_expire | retry_sweep | force_refund | scrub_secrets)'));
        return;
    }

    const before = swap.status;

    switch (action) {
        case 'force_expire': {
            const FORCE_EXPIRE_ALLOWED = new Set([
                SwapStatus.TAKE_PENDING, SwapStatus.TAKEN,
                SwapStatus.XMR_LOCKING, SwapStatus.XMR_LOCKED,
            ]);
            if (!FORCE_EXPIRE_ALLOWED.has(swap.status)) {
                jsonResponse(res, 409, fail('INVALID_STATE', `Cannot force_expire from ${swap.status}`));
                return;
            }
            const updated = storage.updateSwap(
                swapId,
                { status: SwapStatus.EXPIRED },
                swap.status,
                `Admin force_expire from ${swap.status}`,
            );
            stateMachine.notifyTransition(updated, before, SwapStatus.EXPIRED);
            wsServer.broadcastSwapUpdate(updated);
            log.warn(`Admin force_expire: ${before} → EXPIRED`, swapId);
            jsonResponse(res, 200, success({ before, after: SwapStatus.EXPIRED, swap: sanitizeSwapForApi(updated) }));
            break;
        }

        case 'retry_sweep': {
            if (!swap.sweep_status?.startsWith('failed:')) {
                jsonResponse(res, 409, fail('INVALID_STATE', `Cannot retry_sweep: sweep_status is "${swap.sweep_status}", expected "failed:..."`));
                return;
            }
            storage.updateSwap(swapId, { sweep_status: 'pending' });
            log.warn('Admin retry_sweep: reset sweep_status to pending', swapId);
            jsonResponse(res, 200, success({ before: swap.sweep_status, after: 'pending' }));
            break;
        }

        case 'force_refund': {
            if (swap.status !== SwapStatus.EXPIRED) {
                jsonResponse(res, 409, fail('INVALID_STATE', `Cannot force_refund from ${swap.status}, must be EXPIRED`));
                return;
            }
            const refundTx = body['opnet_refund_tx'];
            if (typeof refundTx !== 'string' || !/^[0-9a-f]{64}$/i.test(refundTx)) {
                jsonResponse(res, 400, fail('VALIDATION', 'Required: opnet_refund_tx (64 hex char tx hash)'));
                return;
            }
            const updated = storage.updateSwap(
                swapId,
                { status: SwapStatus.REFUNDED, opnet_refund_tx: refundTx.toLowerCase() },
                SwapStatus.EXPIRED,
                `Admin force_refund with tx ${refundTx.slice(0, 16)}...`,
            );
            stateMachine.notifyTransition(updated, SwapStatus.EXPIRED, SwapStatus.REFUNDED);
            wsServer.broadcastSwapUpdate(updated);
            log.warn(`Admin force_refund: EXPIRED → REFUNDED`, swapId);
            jsonResponse(res, 200, success({ before, after: SwapStatus.REFUNDED, swap: sanitizeSwapForApi(updated) }));
            break;
        }

        case 'scrub_secrets': {
            const TERMINAL = new Set([SwapStatus.COMPLETED, SwapStatus.REFUNDED]);
            if (!TERMINAL.has(swap.status)) {
                jsonResponse(res, 409, fail('INVALID_STATE', `Cannot scrub_secrets from ${swap.status}, must be COMPLETED or REFUNDED`));
                return;
            }
            storage.updateSwap(swapId, {
                preimage: null,
                alice_view_key: null,
                bob_view_key: null,
                bob_spend_key: null,
                claim_token: null,
                recovery_token: null,
            } as IUpdateSwapParams);
            log.warn('Admin scrub_secrets: cleared sensitive fields', swapId);
            jsonResponse(res, 200, success({ scrubbed: true }));
            break;
        }

        default:
            jsonResponse(res, 400, fail('VALIDATION', `Unknown action: ${action}. Must be force_expire | retry_sweep | force_refund | scrub_secrets`));
    }
    }); // end withSwapLock
}

// ---------------------------------------------------------------------------
// Hex conversion helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        const hi = hex.charCodeAt(i * 2);
        const lo = hex.charCodeAt(i * 2 + 1);
        bytes[i] = (hexCharToNibble(hi) << 4) | hexCharToNibble(lo);
    }
    return bytes;
}

function hexCharToNibble(c: number): number {
    // 0-9: 48-57, a-f: 97-102
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    throw new Error(`Invalid hex character: ${String.fromCharCode(c)}`);
}

/**
 * Handler: POST /api/secrets/backup
 * Pre-registers a secret before the swap exists on-chain.
 * Accepts { hashLock, secret, aliceViewKey?, aliceXmrPayout? }
 */
export async function handleBackupSecret(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
): Promise<void> {
    if (!backupSecretLimiter.check(getClientIp(req))) { tooManyRequests(res); return; }

    let hashLock: string;
    let secret: string;
    let aliceViewKey: string | undefined;
    let aliceXmrPayout: string | undefined;
    let recoveryToken: string | undefined;

    try {
        const parsed = await readBody(req);
        const candidate = parsed as Record<string, unknown>;
        if (typeof candidate['hashLock'] !== 'string' || typeof candidate['secret'] !== 'string') {
            jsonResponse(res, 400, fail('VALIDATION', 'hashLock and secret (hex strings) are required'));
            return;
        }
        hashLock = candidate['hashLock'].trim().toLowerCase();
        secret = candidate['secret'].trim().toLowerCase();
        if (typeof candidate['aliceViewKey'] === 'string') {
            aliceViewKey = candidate['aliceViewKey'].trim().toLowerCase();
        }
        if (typeof candidate['aliceXmrPayout'] === 'string' && candidate['aliceXmrPayout'].length > 0) {
            aliceXmrPayout = candidate['aliceXmrPayout'].trim();
        }
        if (typeof candidate['recoveryToken'] === 'string') {
            recoveryToken = candidate['recoveryToken'].trim().toLowerCase();
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    if (!/^[0-9a-f]{64}$/.test(hashLock)) {
        jsonResponse(res, 400, fail('VALIDATION', 'hashLock must be exactly 64 hex characters'));
        return;
    }
    if (!/^[0-9a-f]{64}$/.test(secret)) {
        jsonResponse(res, 400, fail('VALIDATION', 'secret must be exactly 64 hex characters'));
        return;
    }
    if (aliceViewKey !== undefined && !/^[0-9a-f]{64}$/.test(aliceViewKey)) {
        jsonResponse(res, 400, fail('VALIDATION', 'aliceViewKey must be exactly 64 hex characters'));
        return;
    }
    if (recoveryToken !== undefined && !/^[0-9a-f]{64}$/.test(recoveryToken)) {
        jsonResponse(res, 400, fail('VALIDATION', 'recoveryToken must be exactly 64 hex characters'));
        return;
    }
    if (aliceXmrPayout !== undefined) {
        const addrErr = validateMoneroAddress(aliceXmrPayout);
        if (addrErr !== null) {
            jsonResponse(res, 400, fail('VALIDATION', `Invalid aliceXmrPayout: ${addrErr}`));
            return;
        }
    }

    if (!verifyPreimage(secret, hashLock)) {
        jsonResponse(res, 400, fail('HASH_MISMATCH', 'SHA-256(secret) does not match hashLock'));
        return;
    }

    storage.backupSecret(hashLock, secret, aliceViewKey ?? null, aliceXmrPayout ?? null, recoveryToken ?? null);
    jsonResponse(res, 200, success({ backed_up: true }));
}

/**
 * Handler: GET /api/swaps/:id/my-secret
 * Alice recovers her preimage + view key from the coordinator.
 * Auth: X-Recovery-Token header must match swap.recovery_token (issued at swap creation).
 */
export function handleGetMySecret(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
): void {
    if (!recoverSecretLimiter.check(getClientIp(req))) { tooManyRequests(res); return; }
    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', 'Swap not found'));
        return;
    }
    if (!swap.preimage) {
        jsonResponse(res, 404, fail('NO_SECRET', 'No secret stored for this swap'));
        return;
    }

    // Auth: require recovery_token (issued at swap creation, known only to Alice)
    const token = req.headers['x-recovery-token'];
    if (typeof token !== 'string' || !token) {
        jsonResponse(res, 401, fail('AUTH_REQUIRED', 'X-Recovery-Token header is required'));
        return;
    }
    if (!swap.recovery_token || swap.recovery_token.length === 0) {
        jsonResponse(res, 403, fail('NO_TOKEN', 'No recovery token set for this swap'));
        return;
    }
    if (!safeTokenCompare(swap.recovery_token, token)) {
        jsonResponse(res, 403, fail('FORBIDDEN', 'Invalid recovery token'));
        return;
    }

    jsonResponse(res, 200, success({
        preimage: swap.preimage,
        aliceViewKey: swap.alice_view_key,
        aliceXmrPayout: swap.alice_xmr_payout,
        hashLock: swap.hash_lock,
    }));
}

/**
 * Handler: GET /api/swaps/:id/my-keys
 * Bob recovers his key material from the coordinator.
 * Auth: X-Claim-Token header must match swap.claim_token (issued at take time).
 */
export function handleGetMyKeys(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
): void {
    if (!recoverSecretLimiter.check(getClientIp(req))) { tooManyRequests(res); return; }
    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', 'Swap not found'));
        return;
    }

    // Auth: require claim_token (issued to Bob at take time)
    const token = req.headers['x-claim-token'];
    if (typeof token !== 'string' || !token) {
        jsonResponse(res, 401, fail('AUTH_REQUIRED', 'X-Claim-Token header is required'));
        return;
    }
    if (!swap.claim_token || swap.claim_token.length === 0) {
        jsonResponse(res, 403, fail('NO_TOKEN', 'No claim token set for this swap'));
        return;
    }
    if (!safeTokenCompare(swap.claim_token, token)) {
        jsonResponse(res, 403, fail('FORBIDDEN', 'Invalid claim token'));
        return;
    }

    // bob_spend_key intentionally NOT returned — coordinator holds it for sweep.
    // Exposing it would let anyone with the claim_token reconstruct the combined
    // spend key and potentially front-run the coordinator's sweep.
    jsonResponse(res, 200, success({
        bobEd25519Pub: swap.bob_ed25519_pub,
        bobViewKey: swap.bob_view_key,
    }));
}

function bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b !== undefined) {
            hex += b.toString(16).padStart(2, '0');
        }
    }
    return hex;
}
