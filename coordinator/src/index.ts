/**
 * Coordinator entry point — HTTP server + WebSocket + polling loop.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StorageService } from './storage.js';
import { SwapStateMachine } from './state-machine.js';
import { OpnetWatcher } from './opnet-watcher.js';
import { SwapWebSocketServer } from './websocket.js';
import {
    handleHealth,
    handleListSwaps,
    handleGetSwap,
    handleTakeSwap,
    handleCreateSwap,
    handleGetFeeAddress,
    handleSetFeeAddress,
    handleSubmitSecret,
    handleSubmitKeys,
    handleAdminUpdateSwap,
} from './routes/swaps.js';
import { type ISwapRecord, SwapStatus } from './types.js';
import {
    createMoneroService,
    notifyXmrConfirmed,
    validateMoneroAddress,
    type IMoneroService,
} from './monero-module.js';
import { computeSharedMoneroAddress, addEd25519Scalars } from './crypto/index.js';
import { initEncryption } from './encryption.js';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const DB_PATH = process.env['DB_PATH'] ?? 'coordinator.db';
const EXPIRY_CHECK_INTERVAL_MS = 30_000;

/** Maximum age (ms) for OPEN/TAKEN swaps before time-based emergency expiry. */
const MAX_SWAP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Maximum time (ms) an XMR_LOCKING/XMR_LOCKED swap can be stuck before warning. */
const XMR_STUCK_WARN_MS = 72 * 60 * 60 * 1000; // 72 hours

/**
 * Allowed CORS origin. Defaults to the local Vite dev server.
 * Set CORS_ORIGIN in production to the deployed frontend URL.
 */
const ALLOWED_ORIGIN = process.env['CORS_ORIGIN'] ?? 'http://localhost:5173';

/**
 * Admin API key for protected endpoints (fee-address, swap creation).
 * Must be set in production via ADMIN_API_KEY env var.
 */
const ADMIN_API_KEY = process.env['ADMIN_API_KEY'] ?? '';

// ---------------------------------------------------------------------------
// In-memory rate limiter (sliding window per IP)
// ---------------------------------------------------------------------------

/** When true, rate limiting is disabled entirely (test mode only). */
const RATE_LIMIT_DISABLED = (process.env['RATE_LIMIT_DISABLED'] ?? 'false').toLowerCase() === 'true';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_WRITE = 5; // write requests per minute (strict for mainnet)
const RATE_LIMIT_MAX_READ = 30; // read requests per minute

interface IRateLimitEntry {
    readCount: number;
    writeCount: number;
    resetAt: number;
}

const requestCounts = new Map<string, IRateLimitEntry>();

/** Periodic cleanup of expired rate limit entries to prevent unbounded memory growth. */
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of requestCounts) {
        if (now > val.resetAt) requestCounts.delete(key);
    }
}, RATE_LIMIT_WINDOW_MS * 2).unref();

/** Returns seconds until the rate limit window resets for a given IP, or 0 if not limited. */
function getRateLimitRetryAfter(ip: string): number {
    const entry = requestCounts.get(ip);
    if (!entry) return 0;
    const now = Date.now();
    if (now > entry.resetAt) return 0;
    return Math.ceil((entry.resetAt - now) / 1000);
}

function checkRateLimit(ip: string, isWrite: boolean): boolean {
    const now = Date.now();
    const limit = isWrite ? RATE_LIMIT_MAX_WRITE : RATE_LIMIT_MAX_READ;
    const entry = requestCounts.get(ip);
    if (!entry || now > entry.resetAt) {
        // Clean up expired entries periodically (every new window creation)
        if (requestCounts.size > 100) {
            for (const [key, val] of requestCounts) {
                if (now > val.resetAt) requestCounts.delete(key);
            }
        }
        requestCounts.set(ip, {
            readCount: isWrite ? 0 : 1,
            writeCount: isWrite ? 1 : 0,
            resetAt: now + RATE_LIMIT_WINDOW_MS,
        });
        return true;
    }
    if (isWrite) {
        entry.writeCount++;
        return entry.writeCount <= limit;
    }
    entry.readCount++;
    return entry.readCount <= limit;
}

/**
 * Only trust X-Forwarded-For when behind a known reverse proxy.
 * Set TRUST_PROXY=true in production behind nginx/cloudflare.
 */
const TRUST_PROXY = (process.env['TRUST_PROXY'] ?? 'false').toLowerCase() === 'true';

/** Returns the best-effort client IP from an incoming request. */
function getClientIp(req: IncomingMessage): string {
    if (TRUST_PROXY) {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string') {
            const first = forwarded.split(',')[0];
            return first !== undefined ? first.trim() : 'unknown';
        }
    }
    return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

/** Parsed list of allowed CORS origins (supports comma-separated). */
const ALLOWED_ORIGINS = ALLOWED_ORIGIN.split(',').map((o) => o.trim());

/** Adds CORS and security headers to all responses. */
function addCorsHeaders(res: ServerResponse, req?: IncomingMessage): void {
    // CORS — reflect the matching request origin (only one value allowed in the header)
    const requestOrigin = req?.headers['origin'] ?? '';
    if (ALLOWED_ORIGINS.includes(requestOrigin)) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    // Security headers
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0'); // Modern browsers: CSP supersedes this
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'",
    );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Simple pattern-based URL router. */
function matchRoute(
    pathname: string,
    method: string,
): { route: string; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);

    if (pathname === '/api/health' && method === 'GET') {
        return { route: 'health', params: {} };
    }

    if (pathname === '/api/swaps' && method === 'GET') {
        return { route: 'list_swaps', params: {} };
    }

    if (pathname === '/api/swaps' && method === 'POST') {
        return { route: 'create_swap', params: {} };
    }

    if (pathname === '/api/fee-address' && method === 'GET') {
        return { route: 'get_fee_address', params: {} };
    }

    if (pathname === '/api/fee-address' && method === 'PUT') {
        return { route: 'set_fee_address', params: {} };
    }

    const part0 = parts[0];
    const part1 = parts[1];
    const part2 = parts[2];
    const part3 = parts[3];

    if (
        parts.length === 3 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        method === 'GET' &&
        part2 !== undefined
    ) {
        return { route: 'get_swap', params: { id: part2 } };
    }

    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        part3 === 'take' &&
        method === 'POST' &&
        part2 !== undefined
    ) {
        return { route: 'take_swap', params: { id: part2 } };
    }

    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        part3 === 'secret' &&
        method === 'POST' &&
        part2 !== undefined
    ) {
        return { route: 'submit_secret', params: { id: part2 } };
    }

    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        part3 === 'keys' &&
        method === 'POST' &&
        part2 !== undefined
    ) {
        return { route: 'submit_keys', params: { id: part2 } };
    }

    // PUT /api/admin/swaps/:id — test-only admin state endpoint
    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'admin' &&
        part2 === 'swaps' &&
        method === 'PUT' &&
        part3 !== undefined
    ) {
        return { route: 'admin_update_swap', params: { id: part3 } };
    }

    return null;
}

/** Sends a plain 404 JSON response. */
function notFound(res: ServerResponse): void {
    const body = JSON.stringify({
        success: false,
        data: null,
        error: { code: 'NOT_FOUND', message: 'Route not found', retryable: false },
    });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(body);
}

/** Sends a plain 429 JSON response with Retry-After header. */
function tooManyRequests(res: ServerResponse, retryAfterSec: number): void {
    const body = JSON.stringify({
        success: false,
        data: null,
        error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true },
    });
    res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.max(1, retryAfterSec)),
    });
    res.end(body);
}

/** Sends a plain 401 JSON response. */
function unauthorized(res: ServerResponse): void {
    const body = JSON.stringify({
        success: false,
        data: null,
        error: { code: 'UNAUTHORIZED', message: 'Valid admin API key required', retryable: false },
    });
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(body);
}

/** Checks if the request has a valid admin API key (timing-safe). */
function isAdminAuthorized(req: IncomingMessage): boolean {
    if (ADMIN_API_KEY.length === 0) return false;
    const authHeader = req.headers['authorization'] ?? '';
    const expected = `Bearer ${ADMIN_API_KEY}`;
    if (authHeader.length !== expected.length) return false;
    return timingSafeEqual(
        new TextEncoder().encode(authHeader),
        new TextEncoder().encode(expected),
    );
}

/** Sends a plain 500 JSON response. */
function serverError(res: ServerResponse, message: string): void {
    const body = JSON.stringify({
        success: false,
        data: null,
        error: { code: 'INTERNAL', message, retryable: false },
    });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(body);
}

// ---------------------------------------------------------------------------
// XMR Locking orchestration
// ---------------------------------------------------------------------------

const XMR_LOCK_MAX_RETRIES = 5;

/** In-memory lock to prevent concurrent startXmrLocking for the same swap. */
const xmrLockingInProgress = new Set<string>();

/**
 * Minimum number of blocks remaining on the HTLC timelock before
 * we are willing to start the XMR locking flow. This gives Bob
 * enough time for XMR confirmations (~20 min) + MOTO claim (~5 min).
 * At ~3 min/block on OPNet testnet, 50 blocks ≈ 2.5 hours of safety margin.
 */
const MIN_BLOCKS_REMAINING_FOR_XMR_LOCK = 50;

/**
 * Initiates XMR locking for a swap that has been TAKEN on-chain
 * and has a preimage stored. Generates a lock address, updates DB,
 * transitions to XMR_LOCKING, and starts monitoring.
 * Retries with exponential backoff on failure.
 *
 * @param currentBlockGetter - Function returning the latest known block number.
 */
/**
 * Sweeps XMR from a completed swap's shared lock address.
 * Reconstructs the full spend key from Alice + Bob private keys,
 * then calls moneroService.sweepToFeeWallet() to collect fees.
 *
 * Runs async in the background — errors are logged but don't block the state machine.
 */
async function sweepCompletedSwap(
    swap: ISwapRecord,
    storage: StorageService,
    moneroService: IMoneroService,
): Promise<void> {
    const swapId = swap.swap_id;

    if (!swap.xmr_address) {
        console.warn(`[Sweep] ${swapId}: no XMR lock address — skipping sweep`);
        return;
    }

    // We need both parties' private keys to reconstruct the full spend/view keys.
    // preimage IS Alice's private spend key (in split-key mode).
    // alice_view_key and bob_view_key are the private view key shares.
    // bob_spend_key is Bob's private spend key (submitted with his key material).
    if (!swap.preimage || !swap.alice_view_key || !swap.bob_view_key) {
        console.warn(`[Sweep] ${swapId}: missing key material (preimage/view keys scrubbed?) — skipping sweep`);
        storage.updateSwap(swapId, { sweep_status: 'failed:missing_keys' });
        return;
    }

    if (!swap.bob_spend_key) {
        console.warn(
            `[Sweep] ${swapId}: Bob's private spend key not stored — cannot reconstruct full spend key. ` +
            `Manual sweep needed via monero-wallet-rpc CLI.`,
        );
        storage.updateSwap(swapId, { sweep_status: 'failed:no_bob_spend_key' });
        return;
    }

    // sweep_status already set to 'pending' by caller (onStateChange callback)
    try {
        // Reconstruct the combined private spend key: s = s_alice + s_bob (mod l)
        const aliceSpendBytes = hexToBytes(swap.preimage);
        const bobSpendBytes = hexToBytes(swap.bob_spend_key);
        const combinedSpendKey = addEd25519Scalars(aliceSpendBytes, bobSpendBytes);
        const combinedSpendHex = bytesToHex(combinedSpendKey);

        // Reconstruct the combined private view key: v = v_alice + v_bob (mod l)
        const aliceViewBytes = hexToBytes(swap.alice_view_key);
        const bobViewBytes = hexToBytes(swap.bob_view_key);
        const combinedViewKey = addEd25519Scalars(aliceViewBytes, bobViewBytes);
        const combinedViewHex = bytesToHex(combinedViewKey);

        const feeAmount = BigInt(swap.xmr_fee);
        const aliceAddress = swap.alice_xmr_payout ?? undefined;
        const result = await moneroService.sweepToFeeWallet(
            swapId,
            combinedSpendHex,
            combinedViewHex,
            swap.xmr_address,
            feeAmount,
            aliceAddress,
        );

        if (result.ok) {
            console.log(
                `[Sweep] ${swapId}: SUCCESS — txId=${result.txId?.slice(0, 16) ?? 'unknown'}, ` +
                `fee=${result.feeAmount}, alice=${result.aliceAmount}`,
            );
            storage.updateSwap(swapId, {
                sweep_status: `done:${result.txId ?? 'unknown'}`,
            });
            // Now that sweep succeeded, scrub sensitive key material from DB.
            storage.updateSwap(swapId, {
                preimage: null,
                alice_view_key: null,
                bob_view_key: null,
                bob_spend_key: null,
            } as import('./types.js').IUpdateSwapParams);
            console.log(`[Sweep] ${swapId}: scrubbed key material after successful sweep`);
        } else {
            console.error(`[Sweep] ${swapId}: FAILED — ${result.error ?? 'unknown error'}`);
            storage.updateSwap(swapId, {
                sweep_status: `failed:${result.error ?? 'unknown'}`,
            });
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[Sweep] ${swapId}: error — ${msg}`);
        storage.updateSwap(swapId, { sweep_status: `failed:${msg}` });
    }
}

/** Converts a hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/** Converts Uint8Array to hex string. */
function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function startXmrLocking(
    swapId: string,
    storage: StorageService,
    stateMachine: SwapStateMachine,
    moneroService: IMoneroService,
    wsServer: SwapWebSocketServer,
    currentBlockGetter: () => bigint,
    attempt = 0,
): void {
    // Prevent concurrent invocations for the same swap
    if (xmrLockingInProgress.has(swapId)) {
        console.log(`[XMR Locking] Swap ${swapId} already in progress — skipping duplicate`);
        return;
    }

    const swap = storage.getSwap(swapId);
    if (!swap) {
        console.error(`[XMR Locking] Swap ${swapId} not found`);
        return;
    }

    if (swap.status !== SwapStatus.TAKEN) {
        console.warn(
            `[XMR Locking] Swap ${swapId} is ${swap.status}, expected TAKEN — skipping`,
        );
        return;
    }

    if (!swap.preimage) {
        console.warn(
            `[XMR Locking] Swap ${swapId} has no preimage yet — waiting for secret submission`,
        );
        return;
    }

    // Split-key mode: need both Alice's and Bob's keys before proceeding
    if (swap.trustless_mode === 1) {
        if (!swap.alice_ed25519_pub || !swap.alice_view_key) {
            console.warn(`[XMR Locking] Split-key swap ${swapId} missing Alice's key material — waiting`);
            return;
        }
        if (!swap.bob_ed25519_pub || !swap.bob_view_key) {
            console.warn(`[XMR Locking] Split-key swap ${swapId} missing Bob's key material — waiting`);
            return;
        }
    }

    xmrLockingInProgress.add(swapId);

    // Safety check: refuse to start XMR locking if HTLC timelock is too tight.
    // This prevents Alice from setting a short refund_block that expires during
    // XMR confirmation, leaving Bob with no time to claim MOTO.
    const currentBlock = currentBlockGetter();
    if (currentBlock === 0n) {
        // Block height unknown (watcher hasn't polled yet). Defer XMR locking
        // until we can verify sufficient time remains on the HTLC.
        console.warn(`[XMR Locking] Swap ${swapId} deferred — block height unknown, will retry when available`);
        xmrLockingInProgress.delete(swapId);
        if (attempt < XMR_LOCK_MAX_RETRIES) {
            setTimeout(
                () => startXmrLocking(swapId, storage, stateMachine, moneroService, wsServer, currentBlockGetter, attempt + 1),
                5000,
            );
        }
        return;
    }
    const blocksRemaining = BigInt(swap.refund_block) - currentBlock;
    if (blocksRemaining < BigInt(MIN_BLOCKS_REMAINING_FOR_XMR_LOCK)) {
        console.error(
            `[XMR Locking] Swap ${swapId} rejected — only ${blocksRemaining} blocks remaining ` +
            `(need ${MIN_BLOCKS_REMAINING_FOR_XMR_LOCK}). Timelock too tight for safe XMR locking.`,
        );
        xmrLockingInProgress.delete(swapId);
        return;
    }

    void (async (): Promise<void> => {
        try {
            let xmrLockAddress: string;
            let subaddrIndex: number | undefined;

            if (swap.trustless_mode === 1 && swap.alice_ed25519_pub && swap.alice_view_key && swap.bob_ed25519_pub && swap.bob_view_key) {
                // Split-key mode: compute shared Monero address from split keys
                const aliceSpendPub = hexToUint8(swap.alice_ed25519_pub);
                const bobSpendPub = hexToUint8(swap.bob_ed25519_pub);
                const aliceViewPriv = hexToUint8(swap.alice_view_key);
                const bobViewPriv = hexToUint8(swap.bob_view_key);

                const moneroNetwork = (process.env['MONERO_NETWORK'] ?? 'stagenet') as 'mainnet' | 'stagenet';
                const shared = computeSharedMoneroAddress(
                    aliceSpendPub, bobSpendPub,
                    aliceViewPriv, bobViewPriv,
                    moneroNetwork,
                );
                xmrLockAddress = shared.address;
                console.log(`[XMR Locking] Split-key swap ${swapId} — shared address: ${xmrLockAddress.slice(0, 12)}...`);
            } else {
                // Standard mode: generate address from wallet RPC
                const lockResult = await moneroService.createLockAddress(swapId);
                xmrLockAddress = lockResult.address;
                subaddrIndex = lockResult.subaddrIndex;
            }

            // Validate the generated/computed XMR address before storing
            const addrError = validateMoneroAddress(xmrLockAddress);
            if (addrError !== null) {
                throw new Error(`Generated invalid XMR lock address: ${addrError}`);
            }

            // Set xmr_lock_tx to 'pending' to satisfy the state guard, plus store the address
            storage.updateSwap(swapId, {
                xmr_lock_tx: 'pending',
                xmr_address: xmrLockAddress,
                ...(subaddrIndex !== undefined ? { xmr_subaddr_index: subaddrIndex } : {}),
            } as import('./types.js').IUpdateSwapParams);

            // Validate and transition TAKEN → XMR_LOCKING
            const updated = storage.getSwap(swapId);
            if (!updated) return;

            stateMachine.validate(updated, SwapStatus.XMR_LOCKING);
            const transitioned = storage.updateSwap(
                swapId,
                { status: SwapStatus.XMR_LOCKING },
                SwapStatus.TAKEN,
                `XMR lock address generated: ${xmrLockAddress.slice(0, 12)}...`,
            );
            stateMachine.notifyTransition(transitioned, SwapStatus.TAKEN, SwapStatus.XMR_LOCKING);

            console.log(
                `[XMR Locking] Swap ${swapId} → XMR_LOCKING (address: ${xmrLockAddress.slice(0, 12)}...)`,
            );

            // Transfer XMR from coordinator's wallet to the lock address
            const expectedAmount = BigInt(swap.xmr_total);
            if (expectedAmount <= 0n) {
                console.error(`[XMR Locking] Swap ${swapId} has zero/negative xmr_total — aborting`);
                return;
            }

            // Transfer XMR — retry with backoff if balance is temporarily locked
            let transferTxId: string | null = null;
            const maxTransferAttempts = 11;
            for (let txAttempt = 1; txAttempt <= maxTransferAttempts; txAttempt++) {
                const result = await moneroService.transferToLockAddress(swapId, xmrLockAddress, expectedAmount);
                if (result.ok) {
                    transferTxId = result.txId;
                    if (transferTxId) {
                        storage.updateSwap(swapId, { xmr_lock_tx: transferTxId });
                        console.log(`[XMR Locking] Swap ${swapId} — XMR sent! tx: ${transferTxId.slice(0, 16)}...`);
                    }
                    break;
                }
                console.error(`[XMR Locking] Swap ${swapId} — transfer attempt ${txAttempt}/${maxTransferAttempts} failed: ${result.error}`);
                if (txAttempt === maxTransferAttempts) {
                    console.error(`[XMR Locking] Swap ${swapId} — all transfer attempts exhausted`);
                    xmrLockingInProgress.delete(swapId);
                    return;
                }
                const delayMs = Math.min(30000 * txAttempt, 120000);
                console.log(`[XMR Locking] Swap ${swapId} — retrying in ${delayMs / 1000}s...`);
                await new Promise<void>(resolve => setTimeout(resolve, delayMs));
            }

            // Start monitoring the XMR lock for confirmations.
            // For split-key mode (shared address not in our wallet), track by outgoing tx hash.
            // For standard mode (subaddress in our wallet), track by incoming transfers.
            const lockTxId = transferTxId ?? undefined;
            moneroService.startMonitoring(
                swapId,
                xmrLockAddress,
                expectedAmount,
                // onConfirmed: 10 confs reached
                (confirmations: number, txId: string) => {
                    console.log(
                        `[XMR Locking] Swap ${swapId} XMR confirmed (${confirmations} confs, tx: ${txId.slice(0, 16)}...)`,
                    );
                    // Update xmr_lock_tx with the real txId
                    storage.updateSwap(swapId, { xmr_lock_tx: txId });
                    notifyXmrConfirmed(swapId, confirmations, storage, stateMachine, wsServer);
                },
                // onProgress: intermediate confirmations
                (confirmations: number) => {
                    storage.updateSwap(swapId, { xmr_lock_confirmations: confirmations });
                    // Broadcast progress update so frontend sees confirmation count
                    const current = storage.getSwap(swapId);
                    if (current) {
                        wsServer.broadcastSwapUpdate(current);
                    }
                },
                subaddrIndex,
                lockTxId,
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[XMR Locking] Failed for swap ${swapId} (attempt ${attempt + 1}): ${msg}`);
            xmrLockingInProgress.delete(swapId);
            if (attempt < XMR_LOCK_MAX_RETRIES) {
                const delayMs = Math.min(1000 * Math.pow(2, attempt), 30000);
                console.log(`[XMR Locking] Retrying swap ${swapId} in ${delayMs}ms...`);
                setTimeout(
                    () => startXmrLocking(swapId, storage, stateMachine, moneroService, wsServer, currentBlockGetter, attempt + 1),
                    delayMs,
                );
            } else {
                console.error(`[XMR Locking] Max retries (${XMR_LOCK_MAX_RETRIES}) reached for swap ${swapId} — swap stuck in TAKEN`);
            }
        }
    })();
}

async function main(): Promise<void> {
    // Initialize field-level encryption
    const encryptionEnabled = initEncryption();

    // HTTPS/TLS enforcement: in production, require TLS termination (reverse proxy)
    const requireTls = (process.env['REQUIRE_TLS'] ?? 'false').toLowerCase() === 'true';
    if (requireTls) {
        const corsOrigin = process.env['CORS_ORIGIN'] ?? '';
        if (!corsOrigin.startsWith('https://')) {
            console.error(
                '[Coordinator] REQUIRE_TLS=true but CORS_ORIGIN does not start with https://. ' +
                'Deploy behind a TLS-terminating reverse proxy (nginx/Caddy) and set CORS_ORIGIN=https://your-domain.',
            );
            process.exit(1);
        }
        // In production (TLS mode), encryption is mandatory — no plaintext preimages
        if (!encryptionEnabled) {
            console.error(
                '[Coordinator] REQUIRE_TLS=true but ENCRYPTION_KEY is not set. ' +
                'Field-level encryption is MANDATORY in production to protect preimages and view keys at rest.',
            );
            process.exit(1);
        }
        console.log('[Coordinator] TLS enforcement enabled — CORS_ORIGIN is HTTPS, encryption active.');
    }

    // Validate admin key
    if (ADMIN_API_KEY.length === 0) {
        console.warn('[Coordinator] *** WARNING *** ADMIN_API_KEY is not set. Admin endpoints (POST /api/swaps, PUT /api/fee-address) will reject all requests.');
    } else if (ADMIN_API_KEY.length < 32) {
        console.error('[Coordinator] ADMIN_API_KEY must be at least 32 characters. Refusing to start with a weak key.');
        process.exit(1);
    }

    const storage = await StorageService.getInstance(DB_PATH);
    const stateMachine = new SwapStateMachine();
    const watcher = new OpnetWatcher(storage, stateMachine);
    const moneroService = createMoneroService();

    // Verify monero-wallet-rpc is reachable before accepting swaps
    const rpcError = await moneroService.healthCheck();
    if (rpcError !== null) {
        const useMock = (process.env['MONERO_MOCK'] ?? 'false').toLowerCase() === 'true';
        if (useMock) {
            console.log('[Coordinator] Mock mode — skipping RPC health check');
        } else {
            console.error(`[Coordinator] *** FATAL *** ${rpcError}`);
            console.error('[Coordinator] Cannot start without monero-wallet-rpc. Set MONERO_MOCK=true for testing.');
            process.exit(1);
        }
    }

    let wsServer: SwapWebSocketServer | null = null;

    stateMachine.onStateChange((swap: ISwapRecord, from: SwapStatus, to: SwapStatus) => {
        console.log(`[StateMachine] ${swap.swap_id}: ${from} → ${to}`);
        wsServer?.broadcastSwapUpdate(swap);

        // Clean up on terminal states: clear in-memory preimage queue,
        // stop XMR monitoring, and release the locking guard.
        if (to === SwapStatus.COMPLETED || to === SwapStatus.REFUNDED || to === SwapStatus.EXPIRED) {
            wsServer?.clearPendingPreimage(swap.swap_id);
            moneroService.stopMonitoring(swap.swap_id);
            xmrLockingInProgress.delete(swap.swap_id);

            // On COMPLETED trustless swaps: sweep XMR first, then scrub keys after success.
            // Keys must remain in DB until sweep succeeds (retries read from DB).
            if (to === SwapStatus.COMPLETED && swap.trustless_mode === 1) {
                // Set sweep_status BEFORE starting sweep — if process crashes,
                // the swap will be picked up by the sweep retry logic on restart.
                storage.updateSwap(swap.swap_id, { sweep_status: 'pending' });
                void sweepCompletedSwap(swap, storage, moneroService);
                // Only scrub non-sweep-critical fields immediately.
                storage.updateSwap(swap.swap_id, {
                    claim_token: null,
                } as import('./types.js').IUpdateSwapParams);
            } else {
                // Non-trustless or non-COMPLETED: scrub all sensitive data immediately
                storage.updateSwap(swap.swap_id, {
                    preimage: null,
                    claim_token: null,
                    alice_view_key: null,
                    bob_view_key: null,
                    bob_spend_key: null,
                } as import('./types.js').IUpdateSwapParams);
            }
        }

        // When a swap transitions to TAKEN, try to start XMR locking
        // (only works if preimage is already stored)
        if (to === SwapStatus.TAKEN && wsServer) {
            startXmrLocking(swap.swap_id, storage, stateMachine, moneroService, wsServer, () => watcher.getCurrentBlock());
        }
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        addCorsHeaders(res, req);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const ip = getClientIp(req);
        const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';

        if (!RATE_LIMIT_DISABLED && !checkRateLimit(ip, isWrite)) {
            tooManyRequests(res, getRateLimitRetryAfter(ip));
            return;
        }

        const rawUrl = req.url ?? '/';
        const url = new URL(rawUrl, `http://localhost:${PORT}`);
        const pathname = url.pathname;
        const method = req.method ?? 'GET';

        const match = matchRoute(pathname, method);

        if (!match) {
            notFound(res);
            return;
        }

        switch (match.route) {
            case 'health':
                handleHealth(req, res);
                break;

            case 'list_swaps':
                handleListSwaps(req, res, storage);
                break;

            case 'create_swap':
                if (!isAdminAuthorized(req)) {
                    unauthorized(res);
                    break;
                }
                handleCreateSwap(req, res, storage).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    serverError(res, msg);
                });
                break;

            case 'get_fee_address':
                handleGetFeeAddress(req, res);
                break;

            case 'set_fee_address':
                if (!isAdminAuthorized(req)) {
                    unauthorized(res);
                    break;
                }
                handleSetFeeAddress(req, res).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    serverError(res, msg);
                });
                break;

            case 'get_swap': {
                const id = match.params['id'];
                if (!id) {
                    notFound(res);
                    break;
                }
                handleGetSwap(req, res, storage, id);
                break;
            }

            case 'take_swap': {
                const id = match.params['id'];
                if (!id) {
                    notFound(res);
                    break;
                }
                handleTakeSwap(req, res, storage, id, stateMachine, wsServer!).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    serverError(res, msg);
                });
                break;
            }

            case 'submit_secret': {
                const id = match.params['id'];
                if (!id) {
                    notFound(res);
                    break;
                }
                handleSubmitSecret(req, res, storage, id)
                    .then(() => {
                        // After storing the secret, check if the swap is TAKEN
                        // and trigger XMR locking immediately
                        if (wsServer) {
                            const swap = storage.getSwap(id);
                            if (swap && swap.status === SwapStatus.TAKEN && swap.preimage) {
                                startXmrLocking(
                                    id,
                                    storage,
                                    stateMachine,
                                    moneroService,
                                    wsServer,
                                    () => watcher.getCurrentBlock(),
                                );
                            }
                        }
                    })
                    .catch((err: unknown) => {
                        const msg = err instanceof Error ? err.message : 'Unknown error';
                        serverError(res, msg);
                    });
                break;
            }

            case 'submit_keys': {
                const id = match.params['id'];
                if (!id) {
                    notFound(res);
                    break;
                }
                handleSubmitKeys(req, res, storage, id)
                    .then(() => {
                        // After Bob submits keys for a trustless swap that's TAKEN
                        // with a preimage, trigger XMR locking
                        if (wsServer) {
                            const swap = storage.getSwap(id);
                            if (
                                swap &&
                                swap.status === SwapStatus.TAKEN &&
                                swap.preimage &&
                                swap.trustless_mode === 1 &&
                                swap.bob_ed25519_pub
                            ) {
                                startXmrLocking(
                                    id,
                                    storage,
                                    stateMachine,
                                    moneroService,
                                    wsServer,
                                    () => watcher.getCurrentBlock(),
                                );
                            }
                        }
                    })
                    .catch((err: unknown) => {
                        const msg = err instanceof Error ? err.message : 'Unknown error';
                        serverError(res, msg);
                    });
                break;
            }

            case 'admin_update_swap': {
                const id = match.params['id'];
                if (!id) {
                    notFound(res);
                    break;
                }
                if (!isAdminAuthorized(req)) {
                    unauthorized(res);
                    break;
                }
                if (!wsServer) {
                    serverError(res, 'WebSocket server not initialized');
                    break;
                }
                handleAdminUpdateSwap(req, res, storage, stateMachine, wsServer, id).catch(
                    (err: unknown) => {
                        const msg = err instanceof Error ? err.message : 'Unknown error';
                        serverError(res, msg);
                    },
                );
                break;
            }

            default:
                notFound(res);
        }
    });

    wsServer = new SwapWebSocketServer(server, storage);

    await new Promise<void>((resolve, reject) => {
        server.listen(PORT, () => {
            console.log(`[Coordinator] HTTP server listening on port ${PORT}`);
            resolve();
        });
        server.on('error', reject);
    });

    recoverInterruptedSwaps(storage, stateMachine, moneroService, wsServer, () => watcher.getCurrentBlock());

    watcher.start();

    const expiryCheckTimer = setInterval(() => {
        const currentBlock = watcher.getCurrentBlock();
        if (currentBlock > 0n) {
            const expired = watcher.checkExpirations(currentBlock);
            if (expired.length > 0) {
                console.log(`[Cleanup] Marked ${expired.length} swap(s) as expired`);
                for (const swap of expired) {
                    moneroService.stopMonitoring(swap.swap_id);
                    wsServer.clearPendingPreimage(swap.swap_id);
                }
            }
        }

        // Time-based fallback: expire OPEN/TAKEN swaps older than MAX_SWAP_AGE_MS.
        // This catches swaps stuck when OPNet RPC is down (block height stale).
        const allActive = storage.getActiveSwaps();
        const now = Date.now();
        for (const swap of allActive) {
            if (stateMachine.isTerminal(swap.status)) continue;
            if (swap.status === SwapStatus.EXPIRED) continue;

            const createdMs = new Date(swap.created_at).getTime();
            const age = now - createdMs;

            // Only auto-expire OPEN and TAKEN (no XMR at risk)
            if (
                (swap.status === SwapStatus.OPEN || swap.status === SwapStatus.TAKEN) &&
                age > MAX_SWAP_AGE_MS &&
                stateMachine.canTransition(swap.status, SwapStatus.EXPIRED)
            ) {
                const prev = swap.status;
                const updated = storage.updateSwap(
                    swap.swap_id,
                    { status: SwapStatus.EXPIRED },
                    prev,
                    `Time-based expiry: swap age ${Math.round(age / 3600000)}h exceeds 24h limit`,
                );
                stateMachine.notifyTransition(updated, prev, SwapStatus.EXPIRED);
                moneroService.stopMonitoring(swap.swap_id);
                wsServer.clearPendingPreimage(swap.swap_id);
                console.log(`[Cleanup] Time-based expiry: swap ${swap.swap_id} (age: ${Math.round(age / 3600000)}h, was: ${prev})`);
            }

            // Warn about stuck XMR_LOCKING/XMR_LOCKED swaps (don't auto-expire — XMR at risk)
            if (
                (swap.status === SwapStatus.XMR_LOCKING || swap.status === SwapStatus.XMR_LOCKED) &&
                age > XMR_STUCK_WARN_MS
            ) {
                console.warn(
                    `[Cleanup] WARNING: Swap ${swap.swap_id} stuck in ${swap.status} for ${Math.round(age / 3600000)}h. ` +
                    `Manual intervention may be needed. XMR lock address: ${swap.xmr_address ? swap.xmr_address.slice(0, 12) + '...' : 'unknown'}`,
                );
            }
        }
    }, EXPIRY_CHECK_INTERVAL_MS);

    // Periodically retry failed XMR sweeps (every 5 minutes)
    const SWEEP_RETRY_INTERVAL_MS = 5 * 60 * 1000;
    const sweepRetryTimer = setInterval(() => {
        const failed = storage.getFailedSweeps();
        if (failed.length > 0) {
            console.log(`[Sweep Retry] Found ${failed.length} failed sweep(s) — retrying`);
            for (const swap of failed) {
                if (swap.trustless_mode === 1) {
                    void sweepCompletedSwap(swap, storage, moneroService);
                }
            }
        }
    }, SWEEP_RETRY_INTERVAL_MS);

    function shutdown(): void {
        console.log('[Coordinator] Shutting down...');
        clearInterval(expiryCheckTimer);
        clearInterval(sweepRetryTimer);
        moneroService.stopAll();
        watcher.stop();
        wsServer?.close();
        server.close(() => {
            console.log('[Coordinator] HTTP server closed');
            storage.close();
            process.exit(0);
        });
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

function recoverInterruptedSwaps(
    storage: StorageService,
    stateMachine: SwapStateMachine,
    moneroService: IMoneroService,
    wsServer: SwapWebSocketServer,
    currentBlockGetter: () => bigint,
): void {
    const interrupted = storage.listInterruptedSwaps();
    if (interrupted.length === 0) {
        console.log('[Recovery] No interrupted swaps to resume');
        return;
    }
    console.log(`[Recovery] Found ${interrupted.length} interrupted swap(s) — resuming monitoring`);
    for (const swap of interrupted) {
        console.log(`[Recovery]   ${swap.swap_id} (${swap.status})`);

        // Resume XMR monitoring for swaps in XMR_LOCKING that have an address
        if (swap.status === SwapStatus.XMR_LOCKING && swap.xmr_address) {
            let expectedAmount: bigint;
            try {
                expectedAmount = BigInt(swap.xmr_total);
                if (expectedAmount <= 0n) {
                    console.error(`[Recovery] Swap ${swap.swap_id} has invalid xmr_total (${swap.xmr_total}) — skipping`);
                    continue;
                }
            } catch {
                console.error(`[Recovery] Swap ${swap.swap_id} has non-numeric xmr_total (${swap.xmr_total}) — skipping`);
                continue;
            }

            // If xmr_lock_tx is 'pending', the transfer was never sent — attempt it now
            if (!swap.xmr_lock_tx || swap.xmr_lock_tx === 'pending') {
                console.log(`[Recovery] Swap ${swap.swap_id} needs XMR transfer (lockTx=pending) — attempting...`);
                void (async () => {
                    const result = await moneroService.transferToLockAddress(swap.swap_id, swap.xmr_address!, expectedAmount);
                    if (result.ok && result.txId) {
                        storage.updateSwap(swap.swap_id, { xmr_lock_tx: result.txId });
                        console.log(`[Recovery] Swap ${swap.swap_id} — XMR sent! tx: ${result.txId.slice(0, 16)}...`);
                        // Now start monitoring by tx hash
                        moneroService.startMonitoring(
                            swap.swap_id, swap.xmr_address!, expectedAmount,
                            (confs: number, txId: string) => {
                                storage.updateSwap(swap.swap_id, { xmr_lock_tx: txId });
                                notifyXmrConfirmed(swap.swap_id, confs, storage, stateMachine, wsServer);
                            },
                            (confs: number) => {
                                storage.updateSwap(swap.swap_id, { xmr_lock_confirmations: confs });
                                const cur = storage.getSwap(swap.swap_id);
                                if (cur) wsServer.broadcastSwapUpdate(cur);
                            },
                            undefined, result.txId,
                        );
                    } else {
                        console.error(`[Recovery] Swap ${swap.swap_id} — XMR transfer failed: ${result.error}. Will retry on next restart.`);
                    }
                })();
                continue;
            }

            // If xmr_lock_tx is a real tx hash, track by tx hash for confirmations
            const recoveryLockTxId = swap.xmr_lock_tx;
            console.log(
                `[Recovery] Resuming XMR monitoring for swap ${swap.swap_id}` +
                ` (subaddr_index: ${swap.xmr_subaddr_index ?? 'unknown'}` +
                `, lockTx: ${recoveryLockTxId.slice(0, 16)}...)`,
            );
            moneroService.startMonitoring(
                swap.swap_id,
                swap.xmr_address,
                expectedAmount,
                (confirmations: number, txId: string) => {
                    storage.updateSwap(swap.swap_id, { xmr_lock_tx: txId });
                    notifyXmrConfirmed(swap.swap_id, confirmations, storage, stateMachine, wsServer);
                },
                (confirmations: number) => {
                    storage.updateSwap(swap.swap_id, { xmr_lock_confirmations: confirmations });
                    const current = storage.getSwap(swap.swap_id);
                    if (current) {
                        wsServer.broadcastSwapUpdate(current);
                    }
                },
                swap.xmr_subaddr_index ?? undefined,
                recoveryLockTxId,
            );
        }

        // TAKEN swaps with a preimage should start XMR locking
        if (swap.status === SwapStatus.TAKEN && swap.preimage) {
            console.log(`[Recovery] Starting XMR locking for TAKEN swap ${swap.swap_id} with preimage`);
            startXmrLocking(swap.swap_id, storage, stateMachine, moneroService, wsServer, currentBlockGetter);
        }

        // XMR_LOCKED swaps — coordinator may have crashed before broadcasting preimage.
        // Re-broadcast so Bob can still claim MOTO (only if claim_token is set,
        // meaning the swap was properly taken and authenticated subscribers can connect).
        if (swap.status === SwapStatus.XMR_LOCKED && swap.preimage) {
            if (swap.claim_token && swap.claim_token.length > 0) {
                console.log(`[Recovery] Re-broadcasting preimage for XMR_LOCKED swap ${swap.swap_id}`);
                wsServer.broadcastPreimageReady(swap.swap_id, swap.preimage);
            } else {
                console.warn(
                    `[Recovery] Swap ${swap.swap_id} is XMR_LOCKED with preimage but has no claim_token — skipping broadcast`,
                );
            }
        }
    }

    // Retry failed sweeps on startup
    const failedSweeps = storage.getFailedSweeps();
    if (failedSweeps.length > 0) {
        console.log(`[Recovery] Found ${failedSweeps.length} failed sweep(s) — retrying`);
        for (const swap of failedSweeps) {
            if (swap.trustless_mode === 1) {
                void sweepCompletedSwap(swap, storage, moneroService);
            }
        }
    }
}

/** Converts a hex string to Uint8Array. */
function hexToUint8(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        const hi = hex.charCodeAt(i * 2);
        const lo = hex.charCodeAt(i * 2 + 1);
        bytes[i] = (hexNibble(hi) << 4) | hexNibble(lo);
    }
    return bytes;
}

function hexNibble(c: number): number {
    if (c >= 48 && c <= 57) return c - 48;       // 0-9
    if (c >= 97 && c <= 102) return c - 87;       // a-f
    if (c >= 65 && c <= 70) return c - 55;        // A-F
    return 0;
}

main().catch((err: unknown) => {
    if (err instanceof Error) {
        console.error(`[Coordinator] Fatal error: ${err.message}`);
    }
    process.exit(1);
});
