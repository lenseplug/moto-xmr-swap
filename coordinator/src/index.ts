/**
 * Coordinator entry point — HTTP server + WebSocket + polling loop.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
} from './routes/swaps.js';
import { type ISwapRecord, SwapStatus } from './types.js';

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);
const DB_PATH = process.env['DB_PATH'] ?? 'coordinator.db';
const EXPIRY_CHECK_INTERVAL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Allowed CORS origin. Defaults to the local Vite dev server.
 * Set CORS_ORIGIN in production to the deployed frontend URL.
 */
const ALLOWED_ORIGIN = process.env['CORS_ORIGIN'] ?? 'http://localhost:5173';

// ---------------------------------------------------------------------------
// In-memory rate limiter (sliding window per IP)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_WRITE = 10; // write requests per minute
const RATE_LIMIT_MAX_READ = 60; // read requests per minute

interface IRateLimitEntry {
    count: number;
    resetAt: number;
}

const requestCounts = new Map<string, IRateLimitEntry>();

function checkRateLimit(ip: string, isWrite: boolean): boolean {
    const now = Date.now();
    const limit = isWrite ? RATE_LIMIT_MAX_WRITE : RATE_LIMIT_MAX_READ;
    const entry = requestCounts.get(ip);
    if (!entry || now > entry.resetAt) {
        requestCounts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }
    entry.count++;
    return entry.count <= limit;
}

/** Returns the best-effort client IP from an incoming request. */
function getClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
        const first = forwarded.split(',')[0];
        return first !== undefined ? first.trim() : 'unknown';
    }
    return req.socket.remoteAddress ?? 'unknown';
}

// ---------------------------------------------------------------------------
// CORS helpers
// ---------------------------------------------------------------------------

/** Adds CORS headers using the configured allowed origin. */
function addCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
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

/** Sends a plain 429 JSON response. */
function tooManyRequests(res: ServerResponse): void {
    const body = JSON.stringify({
        success: false,
        data: null,
        error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true },
    });
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(body);
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

async function main(): Promise<void> {
    const storage = await StorageService.getInstance(DB_PATH);
    const stateMachine = new SwapStateMachine();
    const watcher = new OpnetWatcher(storage, stateMachine);

    let wsServer: SwapWebSocketServer | null = null;

    stateMachine.onStateChange((swap: ISwapRecord, from: SwapStatus, to: SwapStatus) => {
        console.log(`[StateMachine] ${swap.swap_id}: ${from} → ${to}`);
        wsServer?.broadcastSwapUpdate(swap);
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        addCorsHeaders(res);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const ip = getClientIp(req);
        const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';

        if (!checkRateLimit(ip, isWrite)) {
            tooManyRequests(res);
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
                handleCreateSwap(req, res, storage).catch((err: unknown) => {
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
                handleTakeSwap(req, res, storage, id).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    serverError(res, msg);
                });
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

    recoverInterruptedSwaps(storage);

    watcher.start();

    const expiryCheckTimer = setInterval(() => {
        const currentBlock = watcher.getCurrentBlock();
        if (currentBlock > 0n) {
            const expired = watcher.checkExpirations(currentBlock);
            if (expired.length > 0) {
                console.log(`[Cleanup] Marked ${expired.length} swap(s) as expired`);
            }
        }
    }, EXPIRY_CHECK_INTERVAL_MS);

    const cleanupTimer = setInterval(() => {
        const currentBlock = watcher.getCurrentBlock();
        if (currentBlock > 0n) {
            watcher.checkExpirations(currentBlock);
        }
    }, CLEANUP_INTERVAL_MS);

    function shutdown(): void {
        console.log('[Coordinator] Shutting down...');
        clearInterval(expiryCheckTimer);
        clearInterval(cleanupTimer);
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

function recoverInterruptedSwaps(storage: StorageService): void {
    const interrupted = storage.listInterruptedSwaps();
    if (interrupted.length === 0) {
        console.log('[Recovery] No interrupted swaps to resume');
        return;
    }
    console.log(`[Recovery] Found ${interrupted.length} interrupted swap(s) — resuming monitoring`);
    for (const swap of interrupted) {
        console.log(`[Recovery]   ${swap.swap_id} (${swap.status})`);
    }
}

main().catch((err: unknown) => {
    if (err instanceof Error) {
        console.error(`[Coordinator] Fatal error: ${err.message}`);
    }
    process.exit(1);
});
