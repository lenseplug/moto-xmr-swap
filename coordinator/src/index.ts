/**
 * Coordinator entry point — HTTP server + WebSocket + polling loop.
 */

// Load .env BEFORE any other imports read process.env
import 'dotenv/config';

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
    handleGetSwapByHashLock,
    handleGetSwapByClaimToken,
    handleTakeSwap,
    handleCreateSwap,
    handleGetFeeAddress,
    handleSetFeeAddress,
    handleSubmitSecret,
    handleSubmitKeys,
    handleAdminUpdateSwap,
    handleAdminRecover,
    handleBackupSecret,
    handleGetMySecret,
    handleGetMyKeys,
    withSwapLock,
    claimXmrLimiter,
    SwapLockTimeoutError,
} from './routes/swaps.js';
import { type ISwapRecord, SwapStatus, type IUpdateSwapParams, FEE_BPS, MAX_FEE_BPS } from './types.js';
import { SweepQueue, type SweepJob } from './sweep-queue.js';
import {
    createMoneroService,
    notifyXmrConfirmed,
    clearXmrConfirmed,
    validateMoneroAddress,
    isWalletHealthy,
    type IMoneroService,
} from './monero-module.js';
import { computeSharedMoneroAddress, addEd25519Scalars, validateCombinedKey } from './crypto/index.js';
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

/** When true, rate limiting is disabled entirely (test/dev mode only). */
const RATE_LIMIT_DISABLED = (() => {
    const disabled = (process.env['RATE_LIMIT_DISABLED'] ?? 'false').toLowerCase() === 'true';
    if (disabled) {
        const isProduction = process.env['NODE_ENV'] === 'production' ||
            (process.env['REQUIRE_TLS'] ?? 'false').toLowerCase() === 'true';
        if (isProduction) {
            console.error('[Coordinator] FATAL: RATE_LIMIT_DISABLED=true is FORBIDDEN in production.');
            process.exit(1);
        }
        console.warn('[Coordinator] *** WARNING *** Rate limiting is DISABLED (RATE_LIMIT_DISABLED=true)');
    }
    return disabled;
})();

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

/**
 * Returns the best-effort client IP from an incoming request.
 * When behind a trusted proxy (TRUST_PROXY=true), uses the rightmost non-private
 * IP from X-Forwarded-For. Leftmost is attacker-controlled; rightmost is set by
 * the last trusted proxy.
 */
function getClientIp(req: IncomingMessage): string {
    if (TRUST_PROXY) {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string') {
            // Rightmost entry is the one set by the reverse proxy (Cloudflare, nginx).
            // Leftmost is attacker-controlled and trivially spoofable.
            const parts = forwarded.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            const rightmost = parts[parts.length - 1];
            return rightmost ?? 'unknown';
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Recovery-Token, X-Claim-Token');
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

    // POST /api/secrets/backup — pre-register secret before swap exists on-chain
    if (pathname === '/api/secrets/backup' && method === 'POST') {
        return { route: 'backup_secret', params: {} };
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

    // Validate swap ID path parameters to prevent log injection and memory abuse.
    // Swap IDs are numeric strings, max 78 chars. Reject anything else early.
    if (part0 === 'api' && part1 === 'swaps' && part2 !== undefined
        && part2 !== 'by-hashlock' && part2 !== 'by-claim-token') {
        if (!/^[0-9]{1,78}$/.test(part2)) return null;
    }
    if (part0 === 'api' && part1 === 'admin' && part2 === 'swaps' && part3 !== undefined) {
        if (!/^[0-9]{1,78}$/.test(part3)) return null;
    }

    // GET /api/swaps/by-hashlock/:hashLockHex
    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        part2 === 'by-hashlock' &&
        method === 'GET' &&
        part3 !== undefined &&
        part3.length <= 128
    ) {
        return { route: 'get_swap_by_hashlock', params: { hex: part3 } };
    }

    // GET /api/swaps/by-claim-token/:claimTokenHex
    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        part2 === 'by-claim-token' &&
        method === 'GET' &&
        part3 !== undefined &&
        part3.length <= 128
    ) {
        return { route: 'get_swap_by_claim_token', params: { hex: part3 } };
    }

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

    // PUT /api/swaps/:id/xmr-txid — operator submits XMR tx hash after external deposit
    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        part3 === 'xmr-txid' &&
        method === 'PUT' &&
        part2 !== undefined
    ) {
        return { route: 'submit_xmr_txid', params: { id: part2 } };
    }

    // POST /api/swaps/:id/claim-xmr — Alice triggers XMR sweep to her address
    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        part3 === 'claim-xmr' &&
        method === 'POST' &&
        part2 !== undefined
    ) {
        return { route: 'claim_xmr', params: { id: part2 } };
    }

    // GET /api/swaps/:id/my-secret — Alice recovers her secret (auth: X-Depositor)
    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        part3 === 'my-secret' &&
        method === 'GET' &&
        part2 !== undefined
    ) {
        return { route: 'get_my_secret', params: { id: part2 } };
    }

    // GET /api/swaps/:id/my-keys — Bob recovers his keys (auth: X-Counterparty)
    if (
        parts.length === 4 &&
        part0 === 'api' &&
        part1 === 'swaps' &&
        part3 === 'my-keys' &&
        method === 'GET' &&
        part2 !== undefined
    ) {
        return { route: 'get_my_keys', params: { id: part2 } };
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

    // POST /api/admin/swaps/:id/recover — admin recovery endpoint
    if (
        parts.length === 5 &&
        part0 === 'api' &&
        part1 === 'admin' &&
        part2 === 'swaps' &&
        method === 'POST' &&
        part3 !== undefined
    ) {
        const part4 = parts[4];
        if (part4 === 'recover') {
            return { route: 'admin_recover', params: { id: part3 } };
        }
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

/** Sends 503 on swap lock timeout, 500 otherwise. */
function handleRouteError(res: ServerResponse, err: unknown): void {
    if (err instanceof SwapLockTimeoutError) {
        const body = JSON.stringify({
            success: false,
            data: null,
            error: { code: 'LOCK_TIMEOUT', message: 'Swap is busy, try again', retryable: true },
        });
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
        res.end(body);
        return;
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    serverError(res, msg);
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
const MIN_BLOCKS_REMAINING_FOR_XMR_LOCK = 80;

/**
 * Initiates XMR locking for a swap that has been TAKEN on-chain
 * and has a preimage stored. Generates a lock address, updates DB,
 * transitions to XMR_LOCKING, and starts monitoring.
 * Retries with exponential backoff on failure.
 *
 * @param currentBlockGetter - Function returning the latest known block number.
 */
/**
 * Builds a SweepJob from a completed swap record.
 * Validates that all required key material is present.
 * Returns null if the swap cannot be swept (logs warning).
 */
function buildSweepJob(
    swap: ISwapRecord,
    storage: StorageService,
    overrideDestination?: string,
): SweepJob | null {
    const swapId = swap.swap_id;

    if (!swap.xmr_address) {
        console.warn(`[Sweep] ${swapId}: no XMR lock address — skipping sweep`);
        return null;
    }

    if (!swap.preimage || !swap.alice_view_key || !swap.bob_view_key) {
        console.warn(`[Sweep] ${swapId}: missing key material (preimage/view keys scrubbed?) — skipping sweep`);
        storage.updateSwap(swapId, { sweep_status: 'failed:missing_keys' });
        return null;
    }

    if (!swap.bob_spend_key) {
        console.warn(
            `[Sweep] ${swapId}: Bob's private spend key not stored — cannot reconstruct full spend key. ` +
            `Manual sweep needed via monero-wallet-rpc CLI.`,
        );
        storage.updateSwap(swapId, { sweep_status: 'failed:no_bob_spend_key' });
        return null;
    }

    // Reconstruct the combined private spend key: s = s_alice + s_bob (mod l)
    const aliceSpendBytes = hexToBytes(swap.preimage);
    const bobSpendBytes = hexToBytes(swap.bob_spend_key);
    const combinedSpendKey = addEd25519Scalars(aliceSpendBytes, bobSpendBytes);

    // Validate combined spend key: reject zero scalar, identity point, and torsion points.
    // Ed25519 identity encodes as [1,0,...,0] (not all-zeros), so byte checks alone are insufficient.
    const spendKeyErr = validateCombinedKey(combinedSpendKey);
    if (spendKeyErr !== null) {
        console.error(`[Sweep] ${swapId}: combined spend key INVALID — ${spendKeyErr}. Manual intervention required.`);
        storage.updateSwap(swapId, { sweep_status: 'failed:invalid_combined_spend_key' });
        return null;
    }

    const combinedSpendHex = bytesToHex(combinedSpendKey);

    // Reconstruct the combined private view key: v = v_alice + v_bob (mod l)
    const aliceViewBytes = hexToBytes(swap.alice_view_key);
    const bobViewBytes = hexToBytes(swap.bob_view_key);
    const combinedViewKey = addEd25519Scalars(aliceViewBytes, bobViewBytes);

    // Validate combined view key: reject zero scalar and degenerate points.
    const viewKeyErr = validateCombinedKey(combinedViewKey);
    if (viewKeyErr !== null) {
        console.error(`[Sweep] ${swapId}: combined view key INVALID — ${viewKeyErr}. Manual intervention required.`);
        storage.updateSwap(swapId, { sweep_status: 'failed:invalid_combined_view_key' });
        return null;
    }

    const combinedViewHex = bytesToHex(combinedViewKey);

    return {
        swapId,
        sweepArgs: {
            spendKeyHex: combinedSpendHex,
            viewKeyHex: combinedViewHex,
            lockAddress: swap.xmr_address,
            aliceAmountPiconero: overrideDestination ? BigInt(swap.xmr_total) : BigInt(swap.xmr_amount),
            aliceAddress: overrideDestination ?? swap.alice_xmr_payout ?? undefined,
            lockTxId: swap.xmr_lock_tx ?? undefined,
        },
    };
}

/** Converts a hex string to Uint8Array. Throws on invalid input to prevent silent key corruption. */
function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length === 0 || clean.length % 2 !== 0) {
        throw new Error(`hexToBytes: invalid hex length ${clean.length} (must be even and non-zero)`);
    }
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
        throw new Error('hexToBytes: hex string contains non-hex characters');
    }
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

    // Defer if wallet-rpc is unhealthy — retry instead of wasting attempts
    if (!isWalletHealthy()) {
        console.warn(`[XMR Locking] Swap ${swapId} deferred — wallet-rpc unhealthy, will retry`);
        if (attempt < XMR_LOCK_MAX_RETRIES) {
            const delayMs = Math.min(5000 * Math.pow(2, attempt), 60000);
            setTimeout(
                () => startXmrLocking(swapId, storage, stateMachine, moneroService, wsServer, currentBlockGetter, attempt + 1),
                delayMs,
            );
        }
        return;
    }

    const swap = storage.getSwap(swapId);
    if (!swap) {
        console.error(`[XMR Locking] Swap ${swapId} not found`);
        return;
    }

    // Allow both TAKEN (normal flow) and XMR_LOCKING (retry after crash mid-transition)
    if (swap.status !== SwapStatus.TAKEN && swap.status !== SwapStatus.XMR_LOCKING) {
        console.warn(
            `[XMR Locking] Swap ${swapId} is ${swap.status}, expected TAKEN or XMR_LOCKING — skipping`,
        );
        return;
    }

    if (!swap.preimage) {
        console.warn(
            `[XMR Locking] Swap ${swapId} has no preimage yet — waiting for secret submission`,
        );
        return;
    }

    if (!swap.alice_xmr_payout) {
        console.warn(
            `[XMR Locking] Swap ${swapId} has no alice_xmr_payout — cannot proceed without Alice's XMR payout address`,
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
        // This does NOT count against XMR_LOCK_MAX_RETRIES — it's a transient
        // startup condition that resolves once the watcher syncs.
        console.warn(`[XMR Locking] Swap ${swapId} deferred — block height unknown, will retry when available`);
        xmrLockingInProgress.delete(swapId);
        const delayMs = Math.min(5000 * Math.pow(2, Math.min(attempt, 5)), 60_000);
        setTimeout(
            () => startXmrLocking(swapId, storage, stateMachine, moneroService, wsServer, currentBlockGetter, attempt),
            delayMs,
        );
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

            let sharedViewKeyHex: string | undefined;

            // Idempotency: if xmr_address was already generated (e.g., crash between
            // address generation and status transition), reuse it to prevent orphaning
            // funds that may have already been sent to the original address.
            const existingAddr = swap.xmr_address;
            if (existingAddr && existingAddr.length > 10) {
                xmrLockAddress = existingAddr;
                console.log(`[XMR Locking] Swap ${swapId} — reusing existing address: ${xmrLockAddress.slice(0, 12)}...`);
                // Re-derive shared view key for split-key monitoring
                if (swap.trustless_mode === 1 && swap.alice_view_key && swap.bob_view_key) {
                    const aliceViewPriv = hexToBytes(swap.alice_view_key);
                    const bobViewPriv = hexToBytes(swap.bob_view_key);
                    const combined = addEd25519Scalars(aliceViewPriv, bobViewPriv);
                    sharedViewKeyHex = Buffer.from(combined).toString('hex');
                }
            } else if (swap.trustless_mode === 1 && swap.alice_ed25519_pub && swap.alice_view_key && swap.bob_ed25519_pub && swap.bob_view_key) {
                // Split-key mode: compute shared Monero address from split keys
                const aliceSpendPub = hexToBytes(swap.alice_ed25519_pub);
                const bobSpendPub = hexToBytes(swap.bob_ed25519_pub);
                const aliceViewPriv = hexToBytes(swap.alice_view_key);
                const bobViewPriv = hexToBytes(swap.bob_view_key);

                const moneroNetwork = (process.env['MONERO_NETWORK'] ?? 'stagenet') as 'mainnet' | 'stagenet';
                const shared = computeSharedMoneroAddress(
                    aliceSpendPub, bobSpendPub,
                    aliceViewPriv, bobViewPriv,
                    moneroNetwork,
                );
                xmrLockAddress = shared.address;
                sharedViewKeyHex = Buffer.from(shared.privateViewKey).toString('hex');
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

            // Re-check swap status after async createLockAddress (could have expired during await)
            const freshCheck = storage.getSwap(swapId);
            if (!freshCheck || (freshCheck.status !== SwapStatus.TAKEN && freshCheck.status !== SwapStatus.XMR_LOCKING)) {
                console.warn(`[XMR Locking] Swap ${swapId} is no longer TAKEN/XMR_LOCKING (now: ${freshCheck?.status ?? 'deleted'}) — aborting`);
                xmrLockingInProgress.delete(swapId);
                return;
            }

            // Set xmr_lock_tx to 'pending' to satisfy the state guard, plus store the address
            storage.updateSwap(swapId, {
                xmr_lock_tx: 'pending',
                xmr_address: xmrLockAddress,
                ...(subaddrIndex !== undefined ? { xmr_subaddr_index: subaddrIndex } : {}),
            } as import('./types.js').IUpdateSwapParams);

            // Validate and transition TAKEN → XMR_LOCKING (skip if already XMR_LOCKING from prior crash)
            const updated = storage.getSwap(swapId);
            if (!updated) return;

            if (updated.status === SwapStatus.TAKEN) {
                stateMachine.validate(updated, SwapStatus.XMR_LOCKING);
                const transitioned = storage.updateSwap(
                    swapId,
                    { status: SwapStatus.XMR_LOCKING },
                    SwapStatus.TAKEN,
                    `XMR lock address generated: ${xmrLockAddress.slice(0, 12)}...`,
                );
                stateMachine.notifyTransition(transitioned, SwapStatus.TAKEN, SwapStatus.XMR_LOCKING);
            } else {
                console.log(`[XMR Locking] Swap ${swapId} already in ${updated.status} — skipping transition, resuming monitoring`);
            }

            // Release the locking guard now that transition is committed.
            // Monitoring below is long-lived; the guard's job is done.
            xmrLockingInProgress.delete(swapId);

            console.log(
                `[XMR Locking] Swap ${swapId} → XMR_LOCKING (address: ${xmrLockAddress.slice(0, 12)}...)`,
            );

            // External funding: log the lock address + amount for operator to send manually.
            // Operator submits txid via PUT /api/swaps/:id/xmr-txid after sending.
            const expectedAmount = BigInt(swap.xmr_total);
            if (expectedAmount <= 0n) {
                console.error(`[XMR Locking] Swap ${swapId} has zero/negative xmr_total — aborting`);
                return;
            }

            console.log(`[XMR Locking] Swap ${swapId} — awaiting external XMR deposit:`);
            console.log(`[XMR Locking]   Address: ${xmrLockAddress}`);
            console.log(`[XMR Locking]   Amount:  ${expectedAmount} piconero (${Number(expectedAmount) / 1e12} XMR)`);

            // Start monitoring immediately for all swap types.
            moneroService.startMonitoring(
                swapId,
                xmrLockAddress,
                expectedAmount,
                (confirmations: number, txId: string) => {
                    console.log(
                        `[XMR Locking] Swap ${swapId} XMR confirmed (${confirmations} confs, tx: ${txId.slice(0, 16)}...)`,
                    );
                    storage.updateSwap(swapId, { xmr_lock_tx: txId });
                    notifyXmrConfirmed(swapId, confirmations, storage, stateMachine, wsServer, currentBlockGetter);
                },
                (confirmations: number) => {
                    storage.updateSwap(swapId, { xmr_lock_confirmations: confirmations });
                    const current = storage.getSwap(swapId);
                    if (current) {
                        wsServer.broadcastSwapUpdate(current);
                    }
                },
                subaddrIndex,
                undefined,
                sharedViewKeyHex ? { viewKeyHex: sharedViewKeyHex } : undefined,
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

    // Validate admin key — MANDATORY for all deployments.
    // Without ADMIN_API_KEY, admin endpoints (swap creation, fee address, claim-xmr) reject all requests,
    // making the coordinator non-functional.
    if (ADMIN_API_KEY.length === 0) {
        console.error(
            '[Coordinator] FATAL: ADMIN_API_KEY is not set. The coordinator cannot function without an admin key.\n' +
            '[Coordinator] Generate one with: openssl rand -hex 32',
        );
        process.exit(1);
    } else if (ADMIN_API_KEY.length < 32) {
        console.error('[Coordinator] ADMIN_API_KEY must be at least 32 characters. Refusing to start with a weak key.');
        process.exit(1);
    }

    // Validate FEE_BPS is sane (prevents operator accidentally setting 100% fee)
    if (FEE_BPS < 0 || FEE_BPS > MAX_FEE_BPS) {
        console.error(
            `[Coordinator] FATAL: FEE_BPS=${FEE_BPS} is out of range (0–${MAX_FEE_BPS}). ` +
            `This would charge ${(FEE_BPS / 100).toFixed(2)}% fee — likely a misconfiguration.`,
        );
        process.exit(1);
    }

    // Validate fee address at startup (not at sweep time when it's too late)
    const startupFeeAddr = process.env['XMR_FEE_ADDRESS'] ?? '';
    if (startupFeeAddr.length > 0) {
        const feeAddrErr = validateMoneroAddress(startupFeeAddr);
        if (feeAddrErr !== null) {
            console.error(
                `[Coordinator] FATAL: XMR_FEE_ADDRESS is invalid: ${feeAddrErr}\n` +
                `[Coordinator] Fix the address or remove it to disable fee collection.`,
            );
            process.exit(1);
        }
        console.log(`[Coordinator] Fee address validated: ${startupFeeAddr.slice(0, 12)}...${startupFeeAddr.slice(-6)}`);
    } else {
        console.warn('[Coordinator] WARNING: XMR_FEE_ADDRESS not set — dev fee collection disabled.');
    }

    // Warn about critical env vars
    const moneroNetwork = process.env['MONERO_NETWORK'] ?? 'stagenet';
    if (moneroNetwork === 'stagenet') {
        console.warn('[Coordinator] WARNING: MONERO_NETWORK=stagenet — are you sure this is correct for production?');
    }
    const walletName = process.env['XMR_WALLET_NAME'] ?? '';
    if (walletName.length === 0) {
        console.warn('[Coordinator] WARNING: XMR_WALLET_NAME not set — wallet auto-open on healthCheck will fail.');
    }

    const storage = await StorageService.getInstance(DB_PATH);

    // Verify encrypted DB rows can be decrypted with current ENCRYPTION_KEY.
    // Catches key rotation that would silently corrupt preimages/view keys.
    if (encryptionEnabled) {
        const corrupted = storage.verifyEncryptionHealth();
        if (corrupted > 0) {
            console.error(
                `[Coordinator] FATAL: ${corrupted} encrypted field(s) cannot be decrypted with current ENCRYPTION_KEY.\n` +
                `[Coordinator] The ENCRYPTION_KEY was likely changed. Restore the original key or the data is PERMANENTLY LOST.\n` +
                `[Coordinator] Refusing to start — in-flight swaps would lose their preimages and keys.`,
            );
            process.exit(1);
        }
        console.log('[Coordinator] Encryption health check passed — all active swap fields decryptable.');
    }

    const stateMachine = new SwapStateMachine();
    const watcher = new OpnetWatcher(storage, stateMachine);
    const moneroService = createMoneroService();

    // Verify monero-wallet-rpc is reachable before accepting swaps (retry up to 3 times)
    const MAX_HEALTH_RETRIES = 3;
    let rpcError: string | null = null;
    for (let attempt = 1; attempt <= MAX_HEALTH_RETRIES; attempt++) {
        rpcError = await moneroService.healthCheck();
        if (rpcError === null) break;
        console.warn(`[Coordinator] healthCheck attempt ${attempt}/${MAX_HEALTH_RETRIES} failed: ${rpcError}`);
        if (attempt < MAX_HEALTH_RETRIES) {
            console.log(`[Coordinator] Retrying in 10s...`);
            await new Promise((r) => setTimeout(r, 10_000));
        }
    }
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

    // Cache operator's XMR address for refund sweeps (recovery of expired swap XMR)
    let operatorXmrAddress: string | null = null;
    try {
        const rawAddr = await moneroService.getOperatorAddress();
        if (rawAddr) {
            const addrErr = validateMoneroAddress(rawAddr);
            if (addrErr !== null) {
                console.error(`[Coordinator] Operator XMR address INVALID: ${addrErr} — disabling refund sweeps`);
            } else {
                operatorXmrAddress = rawAddr;
                console.log(`[Coordinator] Operator XMR address: ${operatorXmrAddress.slice(0, 12)}...`);
            }
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.warn(`[Coordinator] Could not fetch operator XMR address: ${msg}`);
    }

    let wsServer: SwapWebSocketServer | null = null;

    // Sweep queue — serializes wallet-rpc sweep operations
    const sweepQueue = new SweepQueue(
        async (job) => {
            const { swapId, sweepArgs } = job;
            // Detect refund sweep: swap is EXPIRED (XMR recovery to operator)
            const currentSwap = storage.getSwap(swapId);
            const isRefundSweep = currentSwap?.status === SwapStatus.EXPIRED;
            const logPrefix = isRefundSweep ? '[Refund Sweep]' : '[Sweep]';
            const donePrefix = isRefundSweep ? 'refund_done' : 'done';
            const failedPrefix = isRefundSweep ? 'refund_failed' : 'failed';

            // Idempotency guard: skip if already swept (prevents double-sweep on restart race)
            if (currentSwap?.sweep_status?.startsWith('done:') || currentSwap?.sweep_status?.startsWith('refund_done:')) {
                console.warn(`${logPrefix} ${swapId}: SKIPPED — already swept (${currentSwap.sweep_status})`);
                return;
            }

            // Defer if wallet-rpc is unhealthy — mark as failed so retry timer finds it
            if (!isWalletHealthy()) {
                console.warn(`${logPrefix} ${swapId}: DEFERRED — wallet-rpc unhealthy, marking failed for retry`);
                storage.updateSwap(swapId, { sweep_status: `${failedPrefix}:wallet_unhealthy` });
                return;
            }

            // Persist sweep-in-progress BEFORE executing — if coordinator crashes mid-sweep,
            // the 'sweeping' status ensures the retry timer picks it up on restart.
            storage.updateSwap(swapId, { sweep_status: 'sweeping' });
            storage.persistNow();

            try {
                const result = await moneroService.sweepToFeeWallet(
                    swapId,
                    sweepArgs.spendKeyHex,
                    sweepArgs.viewKeyHex,
                    sweepArgs.lockAddress,
                    sweepArgs.aliceAmountPiconero,
                    sweepArgs.aliceAddress,
                    sweepArgs.lockTxId,
                    // Persist txId IMMEDIATELY after wallet-rpc broadcasts the sweep TX.
                    // This prevents txId loss if coordinator crashes before the executor
                    // finishes (e.g. during closeAndReopen or result processing).
                    (earlyTxId: string) => {
                        storage.updateSwap(swapId, {
                            sweep_status: `${donePrefix}:${earlyTxId}`,
                            xmr_sweep_tx: earlyTxId,
                        } as IUpdateSwapParams);
                        storage.persistNow();
                        console.log(`${logPrefix} ${swapId}: txId persisted immediately after broadcast: ${earlyTxId.slice(0, 16)}...`);
                    },
                );

                if (result.ok) {
                    // Guard: 'unrecorded-prior-sweep' sentinel means empty wallet. If no confirmed
                    // deposit tx exists, the funds were never deposited — treat as failure.
                    if (result.txId === 'unrecorded-prior-sweep' && currentSwap) {
                        const lockTx = currentSwap.xmr_lock_tx;
                        if (!lockTx || lockTx === 'pending') {
                            console.error(
                                `${logPrefix} ${swapId}: empty balance but xmr_lock_tx='${lockTx ?? 'null'}' — ` +
                                `deposit likely never arrived. Treating as sweep failure.`,
                            );
                            storage.updateSwap(swapId, {
                                sweep_status: `${isRefundSweep ? 'refund_failed' : 'failed'}:no_confirmed_deposit`,
                            });
                            return;
                        }
                    }

                    console.log(
                        `${logPrefix} ${swapId}: SUCCESS — txId=${result.txId?.slice(0, 16) ?? 'unknown'}, ` +
                        `fee=${result.feeAmount}, alice=${result.aliceAmount}`,
                    );
                    storage.updateSwap(swapId, {
                        sweep_status: `${donePrefix}:${result.txId ?? 'unknown'}`,
                        xmr_sweep_tx: result.txId ?? null,
                    } as IUpdateSwapParams);

                    // If this was a pre-claim sweep (XMR_SWEEPING), broadcast preimage.
                    // Do NOT scrub keys yet — they're needed until COMPLETED.
                    // IMPORTANT: Re-fetch fresh swap to check current status — the on-chain
                    // watcher may have advanced state (e.g. EXPIRED, REFUNDED) while sweep ran.
                    const freshPostSweep = storage.getSwap(swapId);
                    if (freshPostSweep?.status === SwapStatus.XMR_SWEEPING) {
                        if (freshPostSweep.preimage) {
                            // Re-check HTLC margin before broadcasting
                            const cb = watcher.getCurrentBlock();
                            const remaining = cb > 0n ? BigInt(freshPostSweep.refund_block) - cb : 0n;
                            if (cb === 0n || remaining >= 30n) {
                                try {
                                    wsServer?.broadcastPreimageReady(swapId, freshPostSweep.preimage);
                                    console.log(`[Sweep] ${swapId}: preimage broadcast after successful pre-claim sweep (${remaining} blocks remaining)`);
                                } catch (broadcastErr: unknown) {
                                    // CRITICAL: sweep already succeeded (done:txid persisted above).
                                    // Do NOT overwrite sweep_status on broadcast failure.
                                    const bmsg = broadcastErr instanceof Error ? broadcastErr.message : 'Unknown error';
                                    console.error(`[Sweep] ${swapId}: preimage broadcast FAILED after successful sweep — ${bmsg}. Sweep status preserved. Recovery will retry broadcast.`);
                                }
                            } else {
                                console.error(
                                    `[Sweep] ${swapId}: HTLC margin too tight after sweep (${remaining} blocks remaining). ` +
                                    `NOT broadcasting preimage. Alice already has XMR — manual resolution needed.`,
                                );
                            }
                        }
                    } else if (freshPostSweep && (
                        freshPostSweep.status === SwapStatus.EXPIRED ||
                        freshPostSweep.status === SwapStatus.REFUNDED
                    )) {
                        // Status changed during sweep (e.g. EXPIRED, REFUNDED by OPNet watcher).
                        // Do NOT broadcast preimage — HTLC may no longer be claimable.
                        console.error(
                            `[Sweep] ${swapId}: status changed to ${freshPostSweep.status} during sweep. ` +
                            `NOT broadcasting preimage. Alice already has XMR — manual resolution needed.`,
                        );
                    } else {
                        // Post-COMPLETED or refund sweep — scrub keys immediately
                        storage.updateSwap(swapId, {
                            preimage: null,
                            alice_view_key: null,
                            bob_view_key: null,
                            bob_spend_key: null,
                            alice_xmr_payout: null,
                            recovery_token: null,
                            alice_dleq_proof: null,
                            bob_dleq_proof: null,
                            alice_secp256k1_pub: null,
                            bob_secp256k1_pub: null,
                        } as IUpdateSwapParams);
                        console.log(`${logPrefix} ${swapId}: scrubbed key material + PII after successful sweep`);
                    }
                } else {
                    console.error(`${logPrefix} ${swapId}: FAILED — ${result.error ?? 'unknown error'}`);
                    // Preserve retry count from current sweep_status so MAX_SWEEP_RETRIES is enforced
                    const prevRetries = currentSwap ? getSweepRetryCount(currentSwap.sweep_status) : 0;
                    const retrySuffix = prevRetries > 0 ? `||retries=${prevRetries}` : '';
                    storage.updateSwap(swapId, {
                        sweep_status: `${failedPrefix}:${sanitizeSweepError(result.error ?? 'unknown')}${retrySuffix}`,
                    });
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Unknown error';
                console.error(`${logPrefix} ${swapId}: error — ${msg}`);
                // Preserve retry count from current sweep_status so MAX_SWEEP_RETRIES is enforced
                const prevSwap = storage.getSwap(swapId);
                const prevRetries = prevSwap ? getSweepRetryCount(prevSwap.sweep_status) : 0;
                const retrySuffix = prevRetries > 0 ? `||retries=${prevRetries}` : '';
                storage.updateSwap(swapId, { sweep_status: `${failedPrefix}:${sanitizeSweepError(msg)}${retrySuffix}` });
            }

            // Broadcast updated swap state after sweep completes
            const updated = storage.getSwap(swapId);
            if (updated) wsServer?.broadcastSwapUpdate(updated);
        },
        (positions) => {
            wsServer?.broadcastQueueUpdate(positions);
        },
    );

    stateMachine.onStateChange((swap: ISwapRecord, from: SwapStatus, to: SwapStatus) => {
        console.log(`[StateMachine] ${swap.swap_id}: ${from} → ${to}`);
        wsServer?.broadcastSwapUpdate(swap);

        // XMR_SWEEPING: trigger sweep-before-claim (pre-claim sweep to Alice).
        // After sweep succeeds, the sweep executor broadcasts the preimage.
        if (to === SwapStatus.XMR_SWEEPING && swap.trustless_mode === 1) {
            const freshSwap = storage.getSwap(swap.swap_id);
            if (freshSwap) {
                console.log(`[Sweep] ${swap.swap_id}: enqueuing pre-claim XMR sweep to Alice`);
                const job = buildSweepJob(freshSwap, storage);
                if (job) sweepQueue.enqueue(job);
            }
        }

        // Clean up on terminal states: clear in-memory preimage queue,
        // stop XMR monitoring, release the locking guard, and clear confirmed flag.
        if (to === SwapStatus.COMPLETED || to === SwapStatus.REFUNDED || to === SwapStatus.EXPIRED) {
            wsServer?.clearPendingPreimage(swap.swap_id);
            moneroService.stopMonitoring(swap.swap_id);
            xmrLockingInProgress.delete(swap.swap_id);
            clearXmrConfirmed(swap.swap_id);

            // On COMPLETED trustless swaps: if sweep already done (pre-claim path), just scrub.
            // Otherwise fallback sweep for legacy/admin path.
            if (to === SwapStatus.COMPLETED && swap.trustless_mode === 1) {
                const freshSwap = storage.getSwap(swap.swap_id);
                if (freshSwap?.sweep_status?.startsWith('done:')) {
                    // Pre-claim sweep already completed — just scrub keys + claim_token
                    storage.updateSwap(swap.swap_id, {
                        claim_token: null,
                        preimage: null,
                        alice_view_key: null,
                        bob_view_key: null,
                        bob_spend_key: null,
                        alice_xmr_payout: null,
                        recovery_token: null,
                        alice_dleq_proof: null,
                        bob_dleq_proof: null,
                        alice_secp256k1_pub: null,
                        bob_secp256k1_pub: null,
                    } as IUpdateSwapParams);
                    console.log(`[Sweep] ${swap.swap_id}: pre-claim sweep already done — scrubbed keys`);
                } else {
                    // Fallback: no pre-claim sweep done (admin/legacy path) — enqueue sweep
                    storage.updateSwap(swap.swap_id, { sweep_status: 'pending', claim_token: null } as IUpdateSwapParams);
                    console.log(`[Sweep] ${swap.swap_id}: enqueuing fallback XMR sweep to Alice + fee wallet`);
                    const fallbackSwap = storage.getSwap(swap.swap_id);
                    if (fallbackSwap) {
                        const job = buildSweepJob(fallbackSwap, storage);
                        if (job) sweepQueue.enqueue(job);
                    }
                }
            } else if (to === SwapStatus.EXPIRED && swap.trustless_mode === 1 && swap.xmr_address) {
                // Expired swap with XMR locked: auto-recover XMR to Bob's refund address or operator.
                const refundDest = swap.bob_xmr_refund ?? operatorXmrAddress;
                if (!refundDest) {
                    console.error(`[Refund Sweep] ${swap.swap_id}: no refund destination (no bob_xmr_refund, no operator address)`);
                } else {
                    storage.updateSwap(swap.swap_id, { sweep_status: 'refund_pending', claim_token: null } as IUpdateSwapParams);
                    console.log(`[Refund Sweep] ${swap.swap_id}: enqueuing XMR recovery sweep to ${refundDest.slice(0, 12)}...`);
                    const freshSwap = storage.getSwap(swap.swap_id);
                    if (freshSwap) {
                        const job = buildSweepJob(freshSwap, storage, refundDest);
                        if (job) sweepQueue.enqueue(job);
                    }
                }
            } else {
                // Non-trustless or non-sweepable: scrub all sensitive data immediately
                storage.updateSwap(swap.swap_id, {
                    preimage: null,
                    claim_token: null,
                    alice_view_key: null,
                    bob_view_key: null,
                    bob_spend_key: null,
                    alice_xmr_payout: null,
                    recovery_token: null,
                    alice_dleq_proof: null,
                    bob_dleq_proof: null,
                    alice_secp256k1_pub: null,
                    bob_secp256k1_pub: null,
                } as import('./types.js').IUpdateSwapParams);
            }

            // Flush terminal-state changes to disk immediately.
            // Key scrubs, sweep_status updates, and claim_token nulls are critical —
            // a crash between updateSwap and the next scheduled save could leak secrets.
            storage.persistNow();
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
                handleHealth(req, res, isWalletHealthy);
                break;

            case 'list_swaps':
                handleListSwaps(req, res, storage);
                break;

            case 'create_swap':
                if (!isAdminAuthorized(req)) {
                    unauthorized(res);
                    break;
                }
                handleCreateSwap(req, res, storage, watcher.getCurrentBlock()).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    serverError(res, msg);
                });
                break;

            case 'backup_secret':
                // No admin gate: endpoint is self-authenticating via SHA-256(secret)==hashLock
                // and rate-limited. Removing admin gate so the frontend can pre-register
                // Alice's deterministic recovery token before the swap exists on-chain.
                handleBackupSecret(req, res, storage).catch((err: unknown) => {
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

            case 'get_swap_by_hashlock': {
                const hex = match.params['hex'];
                if (!hex) { notFound(res); break; }
                handleGetSwapByHashLock(req, res, storage, hex);
                break;
            }

            case 'get_swap_by_claim_token': {
                const hex = match.params['hex'];
                if (!hex) { notFound(res); break; }
                handleGetSwapByClaimToken(req, res, storage, hex);
                break;
            }

            case 'get_swap': {
                const id = match.params['id'];
                if (!id) {
                    notFound(res);
                    break;
                }
                handleGetSwap(req, res, storage, id, (swapId) => sweepQueue.getPosition(swapId));
                break;
            }

            case 'take_swap': {
                const id = match.params['id'];
                if (!id) {
                    notFound(res);
                    break;
                }
                if (!wsServer) { serverError(res, 'Server not ready'); break; }
                handleTakeSwap(req, res, storage, id, stateMachine, wsServer).catch((err: unknown) => {
                    handleRouteError(res, err);
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
                        handleRouteError(res, err);
                    });
                break;
            }

            case 'submit_keys': {
                const id = match.params['id'];
                if (!id) {
                    notFound(res);
                    break;
                }
                handleSubmitKeys(req, res, storage, id, stateMachine, wsServer ?? undefined)
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
                        handleRouteError(res, err);
                    });
                break;
            }

            case 'submit_xmr_txid': {
                const id = match.params['id'];
                if (!id) { notFound(res); break; }
                if (!isAdminAuthorized(req)) { unauthorized(res); break; }
                let bodyStr = '';
                let bytesRead = 0;
                let destroyed = false;
                const MAX_TXID_BODY = 4096;
                req.on('data', (chunk: Buffer) => {
                    if (destroyed) return;
                    bytesRead += chunk.length;
                    if (bytesRead > MAX_TXID_BODY) {
                        destroyed = true;
                        req.destroy();
                        res.writeHead(413, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, data: null, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', retryable: false } }));
                        return;
                    }
                    bodyStr += chunk.toString();
                });
                req.on('end', () => {
                    if (destroyed) return;
                    void withSwapLock(id, async () => {
                    try {
                        const parsed = JSON.parse(bodyStr) as Record<string, unknown>;
                        const txid = parsed['txid'];
                        if (typeof txid !== 'string' || !/^[a-fA-F0-9]{64}$/.test(txid)) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, data: null, error: { code: 'VALIDATION', message: 'txid must be a 64-char hex string', retryable: false } }));
                            return;
                        }
                        const swap = storage.getSwap(id);
                        if (!swap) { notFound(res); return; }
                        if (swap.status !== SwapStatus.XMR_LOCKING) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, data: null, error: { code: 'INVALID_STATE', message: `Swap is ${swap.status}, expected XMR_LOCKING`, retryable: false } }));
                            return;
                        }
                        // Reject if txid already set (prevent monitoring redirect via duplicate submission)
                        if (swap.xmr_lock_tx && swap.xmr_lock_tx !== 'pending') {
                            res.writeHead(409, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, data: null, error: { code: 'ALREADY_SET', message: 'xmr_lock_tx is already set — cannot overwrite', retryable: false } }));
                            return;
                        }
                        storage.updateSwap(id, { xmr_lock_tx: txid });
                        console.log(`[XMR TxID] Swap ${id}: operator submitted txid ${txid.slice(0, 16)}...`);
                        // Start daemon-based monitoring with the submitted txid
                        moneroService.stopMonitoring(id);
                        const expectedAmount = BigInt(swap.xmr_total);
                        if (!swap.xmr_address) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, data: null, error: { code: 'INVALID_STATE', message: 'Swap has no XMR lock address', retryable: false } }));
                            return;
                        }
                        moneroService.startMonitoring(
                            id, swap.xmr_address, expectedAmount,
                            (confirmations: number, confirmedTxId: string) => {
                                storage.updateSwap(id, { xmr_lock_tx: confirmedTxId });
                                if (wsServer) notifyXmrConfirmed(id, confirmations, storage, stateMachine, wsServer, () => watcher.getCurrentBlock());
                            },
                            (confirmations: number) => {
                                storage.updateSwap(id, { xmr_lock_confirmations: confirmations });
                                const current = storage.getSwap(id);
                                if (current && wsServer) wsServer.broadcastSwapUpdate(current);
                            },
                            swap.xmr_subaddr_index ?? undefined,
                            txid,
                        );
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, data: { txid } }));
                    } catch {
                        serverError(res, 'Invalid JSON body');
                    }
                    }); // end withSwapLock
                });
                break;
            }

            case 'claim_xmr': {
                const id = match.params['id'];
                if (!id) { notFound(res); break; }
                if (!isAdminAuthorized(req)) { unauthorized(res); break; }
                if (!claimXmrLimiter.check(getClientIp(req))) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, data: null, error: { code: 'RATE_LIMITED', message: 'Too many requests — try again later', retryable: true } }));
                    break;
                }
                // Use withSwapLock to prevent TOCTOU race on concurrent claim-xmr requests
                void withSwapLock(id, async () => {
                    const swap = storage.getSwap(id);
                    if (!swap) { notFound(res); return; }
                    // Only allow claim on COMPLETED trustless swaps awaiting claim
                    if (swap.status !== SwapStatus.COMPLETED) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, data: null, error: { code: 'INVALID_STATE', message: `Swap is ${swap.status}, expected COMPLETED`, retryable: false } }));
                        return;
                    }
                    if (swap.sweep_status?.startsWith('done:')) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, data: null, error: { code: 'ALREADY_CLAIMED', message: 'XMR has already been claimed', retryable: false } }));
                        return;
                    }
                    if (swap.sweep_status === 'pending') {
                        res.writeHead(409, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, data: null, error: { code: 'IN_PROGRESS', message: 'XMR claim is already in progress', retryable: true } }));
                        return;
                    }
                    // Start the sweep via queue
                    storage.updateSwap(id, { sweep_status: 'pending' });
                    const freshSwap = storage.getSwap(id);
                    const job = freshSwap ? buildSweepJob(freshSwap, storage) : null;
                    if (job) {
                        const enqueued = sweepQueue.enqueue(job);
                        if (!enqueued) {
                            storage.updateSwap(id, { sweep_status: 'failed:queue_full' });
                            res.writeHead(503, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: false, error: { code: 'QUEUE_FULL', message: 'Sweep queue at capacity — will retry automatically' } }));
                            return;
                        }
                    }
                    const queuePos = sweepQueue.getPosition(id);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, data: {
                        message: 'XMR claim initiated',
                        ...(queuePos ? { sweepQueuePosition: queuePos.position, sweepQueueTotal: queuePos.total } : {}),
                    } }));
                });
                break;
            }

            case 'get_my_secret': {
                const id = match.params['id'];
                if (!id) { notFound(res); break; }
                handleGetMySecret(req, res, storage, id);
                break;
            }

            case 'get_my_keys': {
                const id = match.params['id'];
                if (!id) { notFound(res); break; }
                handleGetMyKeys(req, res, storage, id);
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

            case 'admin_recover': {
                const id = match.params['id'];
                if (!id) { notFound(res); break; }
                if (!isAdminAuthorized(req)) { unauthorized(res); break; }
                if (!wsServer) { serverError(res, 'WebSocket server not initialized'); break; }
                handleAdminRecover(req, res, storage, stateMachine, wsServer, sweepQueue, id, operatorXmrAddress).catch(
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

    // Set explicit HTTP timeouts to prevent slowloris attacks
    server.requestTimeout = 30_000;   // 30s max for full request
    server.headersTimeout = 15_000;   // 15s max for headers
    server.keepAliveTimeout = 5_000;  // 5s between keep-alive requests

    wsServer = new SwapWebSocketServer(server, storage);

    await new Promise<void>((resolve, reject) => {
        server.listen(PORT, () => {
            console.log(`[Coordinator] HTTP server listening on port ${PORT}`);
            resolve();
        });
        server.on('error', reject);
    });

    // Ensure main wallet is open before recovery (fixes crash-during-sweep stale state)
    try {
        await moneroService.ensureMainWalletOpen();
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[Coordinator] WARN: Failed to ensure main wallet open on startup: ${msg}`);
    }

    recoverInterruptedSwaps(storage, stateMachine, moneroService, wsServer, () => watcher.getCurrentBlock(), sweepQueue, operatorXmrAddress);

    watcher.start();

    // Fix: Retry deferred preimage broadcasts once block height becomes available.
    // During recovery, swaps in XMR_LOCKED/XMR_SWEEPING(sweep done) may have deferred
    // preimage broadcast because currentBlock was 0n. This one-shot timer re-checks.
    const deferredPreimageRetry = setInterval(() => {
        const cb = watcher.getCurrentBlock();
        if (cb === 0n) return; // Watcher hasn't synced yet — keep waiting

        clearInterval(deferredPreimageRetry);
        console.log('[Recovery] Block height now available — checking for deferred preimage broadcasts');

        const active = storage.getActiveSwaps();
        for (const swap of active) {
            if (!swap.preimage) continue;

            // XMR_SWEEPING with sweep done but preimage not broadcast
            if (swap.status === SwapStatus.XMR_SWEEPING && swap.sweep_status?.startsWith('done:')) {
                const remaining = BigInt(swap.refund_block) - cb;
                if (remaining >= 30n) {
                    console.log(`[Recovery/Deferred] Broadcasting preimage for XMR_SWEEPING swap ${swap.swap_id} (${remaining} blocks remaining)`);
                    wsServer.broadcastPreimageReady(swap.swap_id, swap.preimage);
                } else {
                    console.warn(`[Recovery/Deferred] Swap ${swap.swap_id} (XMR_SWEEPING) — margin too tight (${remaining} blocks)`);
                }
            }

            // XMR_LOCKED with preimage ready (non-trustless or legacy)
            if (swap.status === SwapStatus.XMR_LOCKED) {
                const remaining = BigInt(swap.refund_block) - cb;
                if (BigInt(swap.refund_block) <= cb) {
                    console.warn(`[Recovery/Deferred] Swap ${swap.swap_id} HTLC expired — NOT broadcasting`);
                } else if (remaining >= 30n) {
                    console.log(`[Recovery/Deferred] Broadcasting preimage for XMR_LOCKED swap ${swap.swap_id} (${remaining} blocks remaining)`);
                    wsServer.broadcastPreimageReady(swap.swap_id, swap.preimage);
                } else {
                    console.warn(`[Recovery/Deferred] Swap ${swap.swap_id} — margin too tight (${remaining} blocks)`);
                }
            }
        }
    }, 5_000);

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
            try {
                if (stateMachine.isTerminal(swap.status)) continue;
                if (swap.status === SwapStatus.EXPIRED) continue;

                const createdMs = new Date(swap.created_at).getTime();
                const age = now - createdMs;

                // TAKE_PENDING timeout: revert to OPEN after 60s if Bob hasn't submitted keys
                if (swap.status === SwapStatus.TAKE_PENDING && swap.take_pending_at) {
                    const pendingAge = now - new Date(swap.take_pending_at).getTime();
                    if (pendingAge > 60_000 && stateMachine.canTransition(SwapStatus.TAKE_PENDING, SwapStatus.OPEN)) {
                        const updated = storage.updateSwap(
                            swap.swap_id,
                            { status: SwapStatus.OPEN, counterparty: null, claim_token: null, take_pending_at: null },
                            SwapStatus.TAKE_PENDING,
                            `TAKE_PENDING timeout: ${Math.round(pendingAge / 1000)}s without key submission`,
                        );
                        stateMachine.notifyTransition(updated, SwapStatus.TAKE_PENDING, SwapStatus.OPEN);
                        wsServer?.broadcastSwapUpdate(updated);
                        console.log(`[Cleanup] TAKE_PENDING timeout: swap ${swap.swap_id} reverted to OPEN (${Math.round(pendingAge / 1000)}s)`);
                        continue;
                    }
                }

                // Only auto-expire OPEN and TAKEN (no XMR at risk).
                // Skip expiry if XMR locking is actively in progress for this swap.
                if (
                    (swap.status === SwapStatus.OPEN || swap.status === SwapStatus.TAKEN) &&
                    age > MAX_SWAP_AGE_MS &&
                    !xmrLockingInProgress.has(swap.swap_id) &&
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

                // XMR_LOCKING: auto-expire when HTLC timelock has passed.
                // The onStateChange handler will auto-recover XMR via refund sweep.
                // NOTE: XMR_LOCKED is intentionally excluded. Once preimage is broadcast,
                // expiring creates a dangerous race: operator sweeps XMR back while Bob
                // claims MOTO on-chain using the revealed preimage. This would result in
                // both parties getting funds (double-spend). XMR_LOCKED swaps must complete
                // naturally or be handled via manual admin intervention.
                if (
                    swap.status === SwapStatus.XMR_LOCKING &&
                    currentBlock > 0n &&
                    BigInt(swap.refund_block) <= currentBlock &&
                    stateMachine.canTransition(swap.status, SwapStatus.EXPIRED)
                ) {
                    const prev = swap.status;
                    const updated = storage.updateSwap(
                        swap.swap_id,
                        { status: SwapStatus.EXPIRED },
                        prev,
                        `HTLC expired at block ${currentBlock} (refund_block: ${swap.refund_block}). XMR recovery initiated.`,
                    );
                    stateMachine.notifyTransition(updated, prev, SwapStatus.EXPIRED);
                    moneroService.stopMonitoring(swap.swap_id);
                    console.log(`[Cleanup] HTLC expiry: swap ${swap.swap_id} (${prev} → EXPIRED, refund_block: ${swap.refund_block})`);
                }

                // XMR_LOCKED with expired HTLC: auto-expire when BOTH deadline exceeded AND HTLC expired.
                // This prevents double-spend: only expire after on-chain refund window is open.
                if (
                    swap.status === SwapStatus.XMR_LOCKED &&
                    currentBlock > 0n &&
                    BigInt(swap.refund_block) <= currentBlock
                ) {
                    const XMR_LOCKED_DEADLINE_MS = 30 * 60 * 1000;
                    const lockedAt = swap.xmr_locked_at ? new Date(swap.xmr_locked_at).getTime() : 0;
                    const lockedAge = lockedAt > 0 ? now - lockedAt : 0;

                    if (lockedAge > XMR_LOCKED_DEADLINE_MS && stateMachine.canTransition(SwapStatus.XMR_LOCKED, SwapStatus.EXPIRED)) {
                        const prev = swap.status;
                        const updated = storage.updateSwap(
                            swap.swap_id,
                            { status: SwapStatus.EXPIRED },
                            prev,
                            `XMR_LOCKED deadline: locked ${Math.round(lockedAge / 60000)}min + HTLC expired at block ${currentBlock}`,
                        );
                        stateMachine.notifyTransition(updated, prev, SwapStatus.EXPIRED);
                        moneroService.stopMonitoring(swap.swap_id);
                        wsServer?.clearPendingPreimage(swap.swap_id);
                        console.log(`[Cleanup] XMR_LOCKED deadline: swap ${swap.swap_id} expired (locked ${Math.round(lockedAge / 60000)}min, HTLC expired)`);
                    } else {
                        console.warn(
                            `[Cleanup] WARNING: Swap ${swap.swap_id} is XMR_LOCKED, HTLC expired at block ${currentBlock} ` +
                            `(refund_block: ${swap.refund_block})` +
                            (lockedAge > 0 ? `, locked ${Math.round(lockedAge / 60000)}min` : ', xmr_locked_at not set') +
                            `. Waiting for both conditions to auto-expire.`,
                        );
                    }
                }

                // XMR_SWEEPING with expired HTLC: warn but do NOT auto-expire.
                // Sweep may be in progress — expiring could race with sweep completion.
                if (
                    swap.status === SwapStatus.XMR_SWEEPING &&
                    currentBlock > 0n &&
                    BigInt(swap.refund_block) <= currentBlock
                ) {
                    console.warn(
                        `[Cleanup] WARNING: Swap ${swap.swap_id} is XMR_SWEEPING but HTLC expired at block ${currentBlock} ` +
                        `(refund_block: ${swap.refund_block}). NOT auto-expiring to prevent sweep/refund race.`,
                    );
                }

                // Warn about stuck XMR_LOCKING/XMR_LOCKED/XMR_SWEEPING swaps that haven't expired yet
                if (
                    (swap.status === SwapStatus.XMR_LOCKING || swap.status === SwapStatus.XMR_LOCKED || swap.status === SwapStatus.XMR_SWEEPING) &&
                    age > XMR_STUCK_WARN_MS
                ) {
                    console.warn(
                        `[Cleanup] WARNING: Swap ${swap.swap_id} stuck in ${swap.status} for ${Math.round(age / 3600000)}h. ` +
                        `XMR lock address: ${swap.xmr_address ? swap.xmr_address.slice(0, 12) + '...' : 'unknown'}`,
                    );
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[Cleanup] Error processing swap ${swap.swap_id} (${swap.status}): ${msg} — continuing with remaining swaps`);
            }
        }
    }, EXPIRY_CHECK_INTERVAL_MS);

    // Periodically retry failed XMR sweeps (every 5 minutes)
    const SWEEP_RETRY_INTERVAL_MS = 5 * 60 * 1000;
    const MAX_SWEEP_RETRIES = 5;

    /**
     * Sanitizes an error message before embedding in sweep_status.
     * Strips any occurrences of the retry delimiter to prevent injection
     * (e.g., a crafted wallet-rpc error containing "||retries=99").
     */
    function sanitizeSweepError(msg: string): string {
        return msg.replace(/\|\|retries=\d+/g, '').slice(0, 200);
    }

    /** Extracts retry count from sweep_status like "failed:reason||retries=3" */
    function getSweepRetryCount(sweepStatus: string | null): number {
        if (!sweepStatus) return 0;
        // Use || delimiter to avoid confusion with wallet-rpc error message content
        const match = sweepStatus.match(/\|\|retries=(\d+)$/);
        return match ? parseInt(match[1] as string, 10) : 0;
    }

    /** Updates sweep_status with incremented retry count. isRefund=true uses 'refund_failed:' prefix. */
    function bumpSweepRetryCount(swap: ISwapRecord, storage: StorageService, isRefund = false): boolean {
        const count = getSweepRetryCount(swap.sweep_status);
        if (count >= MAX_SWEEP_RETRIES) {
            const prefix = isRefund ? 'refund_failed' : 'failed';
            console.error(`[Sweep Retry] Swap ${swap.swap_id} exceeded max retries (${MAX_SWEEP_RETRIES}) — requires manual intervention`);
            storage.updateSwap(swap.swap_id, { sweep_status: `${prefix}:max_retries_exceeded||retries=${count}` });
            return false;
        }
        return true;
    }

    const sweepRetryTimer = setInterval(() => {
        const failed = storage.getFailedSweeps();
        if (failed.length > 0) {
            console.log(`[Sweep Retry] Found ${failed.length} failed sweep(s) — checking retry limits`);
            for (const swap of failed) {
                if (swap.trustless_mode === 1) {
                    // Skip if already queued — prevents burning retry budget while sweep is processing
                    if (sweepQueue.getPosition(swap.swap_id) !== null) continue;
                    // Skip sweeps for swaps whose HTLC has already expired — they'll waste
                    // wallet-rpc time and block other sweeps in the queue
                    const cb = watcher.getCurrentBlock();
                    if (cb > 0n && BigInt(swap.refund_block) <= cb) {
                        console.warn(`[Sweep Retry] Skipping ${swap.swap_id} — HTLC expired (refund_block ${swap.refund_block} <= current ${cb})`);
                        continue;
                    }
                    if (!bumpSweepRetryCount(swap, storage)) continue;
                    const retries = getSweepRetryCount(swap.sweep_status) + 1;
                    storage.updateSwap(swap.swap_id, { sweep_status: `failed:retry_pending||retries=${retries}` });
                    const job = buildSweepJob(swap, storage);
                    if (job) sweepQueue.enqueue(job);
                }
            }
        }

        // Retry failed refund sweeps (EXPIRED swaps with XMR recovery pending)
        {
            const failedRefunds = storage.getFailedRefundSweeps();
            if (failedRefunds.length > 0) {
                console.log(`[Refund Sweep Retry] Found ${failedRefunds.length} failed refund sweep(s) — checking retry limits`);
                for (const swap of failedRefunds) {
                    if (swap.trustless_mode === 1) {
                        const refundDest = swap.bob_xmr_refund ?? operatorXmrAddress;
                        if (!refundDest) continue;
                        // Skip if already queued — prevents burning retry budget while sweep is processing
                        if (sweepQueue.getPosition(swap.swap_id) !== null) continue;
                        if (!bumpSweepRetryCount(swap, storage, true)) continue;
                        const retries = getSweepRetryCount(swap.sweep_status) + 1;
                        storage.updateSwap(swap.swap_id, { sweep_status: `refund_failed:retry_pending||retries=${retries}` });
                        const job = buildSweepJob(swap, storage, refundDest);
                        if (job) sweepQueue.enqueue(job);
                    }
                }
            }
        }
    }, SWEEP_RETRY_INTERVAL_MS);

    function shutdown(): void {
        console.log('[Coordinator] Shutting down...');
        clearInterval(expiryCheckTimer);
        clearInterval(deferredPreimageRetry);
        clearInterval(sweepRetryTimer);
        moneroService.stopAll();
        watcher.stop();
        wsServer?.close();

        // Wait for in-progress sweep to complete (max 60s) to prevent double-sweep on restart
        const drainSweepQueue = (): Promise<void> => {
            if (!sweepQueue.isProcessing) return Promise.resolve();
            console.log('[Coordinator] Waiting for in-progress sweep to finish...');
            return new Promise((resolve) => {
                let waited = 0;
                const check = setInterval(() => {
                    waited += 1000;
                    if (!sweepQueue.isProcessing || waited >= 60_000) {
                        clearInterval(check);
                        if (waited >= 60_000) console.warn('[Coordinator] Sweep drain timed out after 60s');
                        resolve();
                    }
                }, 1000);
            });
        };

        void drainSweepQueue().then(() => {
            server.close(() => {
                console.log('[Coordinator] HTTP server closed');
                storage.close();
                process.exit(0);
            });
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
    sweepQueue: SweepQueue,
    operatorXmrAddress: string | null,
): void {
    const interrupted = storage.listInterruptedSwaps();
    if (interrupted.length === 0) {
        console.log('[Recovery] No interrupted swaps to resume');
        return;
    }
    console.log(`[Recovery] Found ${interrupted.length} interrupted swap(s) — resuming monitoring`);
    for (const swap of interrupted) {
        console.log(`[Recovery]   ${swap.swap_id} (${swap.status})`);

        // TAKE_PENDING recovery: revert stale reservations to OPEN
        if (swap.status === SwapStatus.TAKE_PENDING) {
            try {
                const updated = storage.updateSwap(
                    swap.swap_id,
                    { status: SwapStatus.OPEN, counterparty: null, claim_token: null, take_pending_at: null },
                    SwapStatus.TAKE_PENDING,
                    'Recovery: stale TAKE_PENDING reverted to OPEN on startup',
                );
                stateMachine.notifyTransition(updated, SwapStatus.TAKE_PENDING, SwapStatus.OPEN);
                console.log(`[Recovery] Reverted TAKE_PENDING → OPEN: ${swap.swap_id}`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[Recovery] Failed to revert TAKE_PENDING for ${swap.swap_id}: ${msg}`);
            }
            continue;
        }

        // XMR_SWEEPING recovery: re-enqueue sweep or re-broadcast preimage
        if (swap.status === SwapStatus.XMR_SWEEPING) {
            if (swap.sweep_status?.startsWith('done:') && swap.preimage) {
                // Sweep completed but preimage may not have been broadcast (crash during broadcast)
                const currentBlock = currentBlockGetter();
                const remaining = currentBlock > 0n ? BigInt(swap.refund_block) - currentBlock : 0n;
                if (currentBlock === 0n) {
                    console.warn(`[Recovery] Swap ${swap.swap_id} (XMR_SWEEPING, sweep done) — block height unknown, deferring preimage broadcast`);
                } else if (remaining >= 30n) {
                    console.log(`[Recovery] Re-broadcasting preimage for XMR_SWEEPING swap ${swap.swap_id} (sweep done, ${remaining} blocks remaining)`);
                    wsServer.broadcastPreimageReady(swap.swap_id, swap.preimage);
                } else {
                    console.warn(`[Recovery] Swap ${swap.swap_id} (XMR_SWEEPING, sweep done) — HTLC margin too tight (${remaining} blocks). NOT re-broadcasting preimage.`);
                }
            } else if (swap.sweep_status === 'pending' || swap.sweep_status?.startsWith('failed:')) {
                // Sweep not yet completed — re-enqueue
                console.log(`[Recovery] Re-enqueuing sweep for XMR_SWEEPING swap ${swap.swap_id} (sweep_status: ${swap.sweep_status})`);
                const job = buildSweepJob(swap, storage);
                if (job) sweepQueue.enqueue(job);
            } else {
                // Unknown sweep_status — set to pending and enqueue
                console.log(`[Recovery] Setting sweep_status=pending for XMR_SWEEPING swap ${swap.swap_id}`);
                storage.updateSwap(swap.swap_id, { sweep_status: 'pending' });
                const job = buildSweepJob(swap, storage);
                if (job) sweepQueue.enqueue(job);
            }
            continue;
        }

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

            // Determine lock tx for monitoring (undefined if not yet submitted)
            const recoveryLockTxId = (swap.xmr_lock_tx && swap.xmr_lock_tx !== 'pending')
                ? swap.xmr_lock_tx
                : undefined;

            // Recompute split-key view key for monitoring if applicable
            let recoverySplitKeyInfo: { viewKeyHex: string } | undefined;
            if (swap.trustless_mode === 1 && swap.alice_view_key && swap.bob_view_key && !recoveryLockTxId) {
                const aliceViewPriv = hexToBytes(swap.alice_view_key);
                const bobViewPriv = hexToBytes(swap.bob_view_key);
                const combinedView = addEd25519Scalars(aliceViewPriv, bobViewPriv);
                recoverySplitKeyInfo = { viewKeyHex: Buffer.from(combinedView).toString('hex') };
            }

            console.log(
                `[Recovery] Resuming XMR monitoring for swap ${swap.swap_id}` +
                ` (subaddr_index: ${swap.xmr_subaddr_index ?? 'unknown'}` +
                `, lockTx: ${recoveryLockTxId ? recoveryLockTxId.slice(0, 16) + '...' : 'awaiting deposit'}` +
                `${recoverySplitKeyInfo ? ', split-key' : ''})`,
            );
            moneroService.startMonitoring(
                swap.swap_id,
                swap.xmr_address,
                expectedAmount,
                (confirmations: number, txId: string) => {
                    storage.updateSwap(swap.swap_id, { xmr_lock_tx: txId });
                    notifyXmrConfirmed(swap.swap_id, confirmations, storage, stateMachine, wsServer, currentBlockGetter);
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
                recoverySplitKeyInfo,
            );
        }

        // TAKEN swaps with a preimage should start XMR locking
        if (swap.status === SwapStatus.TAKEN && swap.preimage) {
            console.log(`[Recovery] Starting XMR locking for TAKEN swap ${swap.swap_id} with preimage`);
            startXmrLocking(swap.swap_id, storage, stateMachine, moneroService, wsServer, currentBlockGetter);
        }

        // MOTO_CLAIMING: coordinator crashed between MOTO_CLAIMING and COMPLETED.
        // If on-chain claim tx is recorded, transition directly to COMPLETED and trigger sweep.
        // Otherwise, the OPNet watcher will pick it up on its next poll cycle.
        if (swap.status === SwapStatus.MOTO_CLAIMING) {
            if (swap.opnet_claim_tx) {
                console.log(`[Recovery] Swap ${swap.swap_id} stuck in MOTO_CLAIMING with claim tx ${swap.opnet_claim_tx.slice(0, 16)}... — transitioning to COMPLETED`);
                try {
                    stateMachine.validate(swap, SwapStatus.COMPLETED);
                    const completed = storage.updateSwap(
                        swap.swap_id,
                        { status: SwapStatus.COMPLETED },
                        SwapStatus.MOTO_CLAIMING,
                        'Recovery: MOTO_CLAIMING → COMPLETED (claim tx already recorded)',
                    );
                    stateMachine.notifyTransition(completed, SwapStatus.MOTO_CLAIMING, SwapStatus.COMPLETED);
                } catch (guardErr: unknown) {
                    const msg = guardErr instanceof Error ? guardErr.message : String(guardErr);
                    console.warn(`[Recovery] Guard rejected MOTO_CLAIMING → COMPLETED for swap ${swap.swap_id}: ${msg}`);
                }
            } else {
                console.log(`[Recovery] Swap ${swap.swap_id} in MOTO_CLAIMING without claim tx — OPNet watcher will resolve`);
            }
            continue; // No XMR monitoring needed for MOTO_CLAIMING
        }

        // XMR_LOCKED swaps — coordinator may have crashed before broadcasting preimage.
        // Re-broadcast so Bob can still claim MOTO. Even if claim_token was scrubbed,
        // the WebSocket fallback allows subscription for post-TAKEN swaps.
        // SAFETY: Check HTLC expiry first — do NOT broadcast if refund window has passed.
        // NOTE: At recovery time, currentBlock is 0n (watcher not started yet), so broadcast
        // is deferred. Once watcher starts, it detects any on-chain refund and updates DB
        // before this path is retried. This prevents broadcasting after HTLC refund.
        if (swap.status === SwapStatus.XMR_LOCKED && swap.preimage) {
            const currentBlock = currentBlockGetter();
            if (currentBlock === 0n) {
                // Block height unknown — defer preimage broadcast until watcher updates.
                // Broadcasting with unknown block height could reveal preimage after HTLC expired.
                console.warn(`[Recovery] Swap ${swap.swap_id} — block height unknown, deferring preimage broadcast until watcher updates`);
            } else if (BigInt(swap.refund_block) <= currentBlock) {
                console.warn(`[Recovery] Swap ${swap.swap_id} HTLC has expired (refund_block: ${swap.refund_block}, current: ${currentBlock}) — NOT re-broadcasting preimage`);
                // Don't broadcast — let expiry handler deal with it
            } else {
                // Check margin: need ≥30 blocks for Bob to claim MOTO
                const blocksRemaining = BigInt(swap.refund_block) - currentBlock;
                if (blocksRemaining < 30n) {
                    console.warn(`[Recovery] Swap ${swap.swap_id} — only ${blocksRemaining} blocks remaining, margin too tight — NOT re-broadcasting preimage`);
                } else {
                    console.log(`[Recovery] Re-broadcasting preimage for XMR_LOCKED swap ${swap.swap_id} (${blocksRemaining} blocks remaining)`);
                    wsServer.broadcastPreimageReady(swap.swap_id, swap.preimage);
                }
            }
        }
    }

    // Retry failed sweeps on startup via queue
    const failedSweeps = storage.getFailedSweeps();
    if (failedSweeps.length > 0) {
        console.log(`[Recovery] Found ${failedSweeps.length} failed sweep(s) — enqueuing`);
        for (const swap of failedSweeps) {
            if (swap.trustless_mode === 1) {
                const job = buildSweepJob(swap, storage);
                if (job) sweepQueue.enqueue(job);
            }
        }
    }

    // Retry failed refund sweeps on startup (EXPIRED swaps with XMR at risk)
    {
        const failedRefunds = storage.getFailedRefundSweeps();
        if (failedRefunds.length > 0) {
            console.log(`[Recovery] Found ${failedRefunds.length} failed refund sweep(s) — enqueuing`);
            for (const swap of failedRefunds) {
                if (swap.trustless_mode === 1) {
                    const refundDest = swap.bob_xmr_refund ?? operatorXmrAddress;
                    if (!refundDest) continue;
                    const job = buildSweepJob(swap, storage, refundDest);
                    if (job) sweepQueue.enqueue(job);
                }
            }
        }
    }
}

// (hexToUint8/hexNibble removed — all callers now use the validated hexToBytes at line ~512)

// ---------------------------------------------------------------------------
// Global error handlers — prevent silent crashes from swallowing stack traces
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err: Error) => {
    console.error(`[Coordinator] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack ?? ''}`);
    // Exit with failure — uncaught exceptions leave the process in an undefined state.
    // The process manager (systemd, pm2) should restart it.
    process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);
    console.error(`[Coordinator] UNHANDLED REJECTION: ${msg}`);
    // Don't exit — unhandled rejections are often recoverable (e.g. network timeouts).
    // Log for debugging; the polling loops will retry on next cycle.
});

main().catch((err: unknown) => {
    if (err instanceof Error) {
        console.error(`[Coordinator] Fatal error: ${err.message}`);
    }
    process.exit(1);
});
