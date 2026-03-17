/**
 * WebSocket server for real-time swap state updates.
 * Uses the built-in `ws` module via Node.js http.Server upgrade.
 *
 * Preimage messages are ONLY sent to clients that have subscribed to
 * the specific swap ID via a { type: 'subscribe', swapId } message.
 */

import { type IncomingMessage, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { type ISwapRecord, type IWsMessage, type IWsPreimageReady, type IWsClientMessage, type IWsQueueUpdate } from './types.js';
import { StorageService } from './storage.js';

const ALLOWED_ORIGIN = process.env['CORS_ORIGIN'] ?? 'http://localhost:5173';
const TRUST_PROXY = (process.env['TRUST_PROXY'] ?? 'false').toLowerCase() === 'true';

/** Max WebSocket message size (bytes). Subscribe messages are ~200 bytes. */
const WS_MAX_PAYLOAD = 4096;

/** Max subscriptions per WebSocket connection. */
const WS_MAX_SUBSCRIPTIONS_PER_CLIENT = 5;

/** WebSocket message rate limit: max messages per window. */
const WS_MSG_RATE_LIMIT = 10;
const WS_MSG_RATE_WINDOW_MS = 10_000;

/** Ping interval for keepalive (ms). */
const WS_PING_INTERVAL_MS = 30_000;

/** Max age for pending preimages before automatic cleanup (ms). */
const PENDING_PREIMAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Max number of pending preimage entries to prevent unbounded memory growth. */
const MAX_PENDING_PREIMAGES = 200;

/** Max WebSocket connections per IP address (relaxed in test mode). */
const WS_MAX_CONNECTIONS_PER_IP =
    (process.env['RATE_LIMIT_DISABLED'] ?? 'false').toLowerCase() === 'true' ? 100 : 10;

/** Global maximum WebSocket connections. */
const WS_MAX_CONNECTIONS_GLOBAL = 500;

interface IPendingPreimage {
    readonly preimage: string;
    readonly storedAt: number;
}

/** Per-connection rate limiter state. */
interface IWsRateState {
    msgCount: number;
    windowStart: number;
}

/**
 * Scans a JSON string for nesting depth without parsing.
 * Counts brace/bracket nesting; ignores characters inside quoted strings.
 * Returns the maximum depth found (0 for flat values, 1 for `{...}`).
 */
function jsonNestingDepth(text: string): number {
    let depth = 0;
    let maxDepth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{' || ch === '[') { depth++; if (depth > maxDepth) maxDepth = depth; }
        else if (ch === '}' || ch === ']') { depth--; }
    }
    return maxDepth;
}

/** Manages WebSocket connections and state-change broadcasts. */
export class SwapWebSocketServer {
    private readonly wss: WebSocketServer;
    private readonly storage: StorageService;

    /** Maps swapId → Set of WebSocket clients subscribed to that swap. */
    private readonly subscriptions = new Map<string, Set<WebSocket>>();

    /** Queued preimages for swaps where no subscriber was connected at broadcast time. */
    private readonly pendingPreimages = new Map<string, IPendingPreimage>();

    /** Per-connection rate limiter. */
    private readonly clientRates = new WeakMap<WebSocket, IWsRateState>();

    /** Per-connection subscription count. */
    private readonly clientSubCounts = new WeakMap<WebSocket, number>();

    /** Tracks which (swapId, client) pairs are authenticated for preimage delivery. */
    private readonly authenticatedSubs = new Map<string, Set<WebSocket>>();

    /** Per-IP connection count tracking for DoS prevention. */
    private readonly ipConnectionCounts = new Map<string, number>();

    /** Maps WebSocket → IP for cleanup on disconnect. */
    private readonly clientIps = new WeakMap<WebSocket, string>();

    /** Ping interval timer. */
    private readonly pingTimer: NodeJS.Timeout;

    /** Pending preimage TTL sweep timer. */
    private readonly preimageSweepTimer: NodeJS.Timeout;

    public constructor(httpServer: Server, storage: StorageService) {
        this.storage = storage;
        this.wss = new WebSocketServer({
            server: httpServer,
            maxPayload: WS_MAX_PAYLOAD,
            verifyClient: ({ origin }: { origin?: string }) => {
                // Allow non-browser clients (scripts, curl) that send no Origin header.
                if (!origin) return true;
                // Support comma-separated origins for dev (e.g. "http://localhost:5173,http://localhost:5174")
                const allowed = ALLOWED_ORIGIN.split(',').map((o) => o.trim());
                return allowed.includes(origin);
            },
        });
        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
            this.handleConnection(ws, req);
        });

        // Ping all clients periodically to detect dead connections.
        // Terminate clients that didn't respond to the last ping.
        this.pingTimer = setInterval(() => {
            for (const client of this.wss.clients) {
                const ws = client as WebSocket & { isAlive?: boolean };
                if (ws.isAlive === false) {
                    ws.terminate();
                    continue;
                }
                ws.isAlive = false;
                ws.ping();
            }
        }, WS_PING_INTERVAL_MS);

        // Periodically sweep expired pending preimages
        this.preimageSweepTimer = setInterval(() => {
            this.sweepExpiredPreimages();
        }, 60 * 60 * 1000); // Every hour

        // Restore persisted pending preimages from DB (survives crash + in-memory eviction)
        const saved = storage.loadPendingPreimages();
        for (const { swapId, preimage } of saved) {
            this.pendingPreimages.set(swapId, { preimage, storedAt: Date.now() });
        }
        if (saved.length > 0) {
            console.log(`[WebSocket] Restored ${saved.length} pending preimage(s) from DB`);
        }

        console.log('[WebSocket] Server attached to HTTP server');
    }

    /**
     * Sends a swap state update ONLY to clients subscribed to this specific swap.
     * Prevents anonymous observers from passively monitoring all coordinator activity.
     * @param swap - The updated swap record.
     */
    public broadcastSwapUpdate(swap: ISwapRecord): void {
        // Sanitize: strip secrets from public broadcast
        const sanitized = { ...swap, preimage: null, claim_token: null, alice_view_key: null, bob_view_key: null, bob_spend_key: null, recovery_token: null, alice_xmr_payout: null };
        const message: IWsMessage = { type: 'swap_update', data: sanitized };
        this.sendToSwapSubscribers(swap.swap_id, message);
    }

    /** Sends a message only to clients subscribed to a specific swap. */
    private sendToSwapSubscribers(swapId: string, message: IWsMessage): void {
        const subs = this.subscriptions.get(swapId);
        if (!subs || subs.size === 0) return;
        const json = JSON.stringify(message);
        let sent = 0;
        for (const client of subs) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(json);
                sent++;
            }
        }
        if (sent > 0) {
            console.log(`[WebSocket] Sent ${message.type} to ${sent} subscriber(s) for swap ${swapId}`);
        }
    }

    /**
     * Sends the preimage ONLY to clients subscribed to this swap.
     * This is the ONLY mechanism by which the preimage is delivered to Bob's frontend.
     * It is never exposed via a public HTTP endpoint or broadcast to all clients.
     *
     * @param swapId - The swap ID.
     * @param preimage - The hex-encoded preimage.
     */
    public broadcastPreimageReady(swapId: string, preimage: string): void {
        // Cap the in-memory queue to prevent unbounded memory growth.
        // Eviction from memory is safe because preimages are backed up to DB.
        if (this.pendingPreimages.size >= MAX_PENDING_PREIMAGES) {
            const oldestKey = this.pendingPreimages.keys().next().value;
            if (oldestKey !== undefined) {
                this.pendingPreimages.delete(oldestKey);
                // DB backup remains — will be loaded on restart or late subscribe
            }
        }
        // Always queue the preimage so late subscribers can receive it
        this.pendingPreimages.set(swapId, { preimage, storedAt: Date.now() });
        // Persist to DB — survives process crash and in-memory eviction
        this.storage.savePendingPreimage(swapId, preimage);

        const payload: IWsPreimageReady = { swapId, preimage };
        const message: IWsMessage = { type: 'preimage_ready', data: payload };
        const json = JSON.stringify(message);

        // Only deliver preimages to authenticated subscribers (those who proved claim_token)
        const authSubscribers = this.authenticatedSubs.get(swapId);
        if (!authSubscribers || authSubscribers.size === 0) {
            console.log(`[WebSocket] Preimage ready for swap ${swapId} — queued for late authenticated subscribers`);
            return;
        }

        let sent = 0;
        for (const client of authSubscribers) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(json);
                sent++;
            }
        }
        console.log(`[WebSocket] Preimage sent to ${sent} authenticated subscriber(s) for swap ${swapId}`);
    }

    /**
     * Sends sweep queue position updates to subscribers of each queued swap.
     * Only delivers positions relevant to each client's subscribed swaps.
     * @param positions - Current queue positions for all queued sweeps.
     */
    public broadcastQueueUpdate(positions: ReadonlyArray<{ readonly swapId: string; readonly position: number; readonly total: number }>): void {
        for (const pos of positions) {
            const data: IWsQueueUpdate = { queue: [pos] };
            const message: IWsMessage = { type: 'queue_update', data };
            this.sendToSwapSubscribers(pos.swapId, message);
        }
    }

    /** Removes a queued preimage (e.g., after swap completes or expires). */
    public clearPendingPreimage(swapId: string): void {
        this.pendingPreimages.delete(swapId);
        this.storage.deletePendingPreimage(swapId);
    }

    /** Returns the count of currently connected clients. */
    public get clientCount(): number {
        return this.wss.clients.size;
    }

    /** Gracefully closes the WebSocket server. */
    public close(): void {
        clearInterval(this.pingTimer);
        clearInterval(this.preimageSweepTimer);
        this.wss.close();
    }

    private handleConnection(ws: WebSocket, req: IncomingMessage): void {
        // Enforce global connection cap
        if (this.wss.clients.size > WS_MAX_CONNECTIONS_GLOBAL) {
            ws.close(1013, 'Server at capacity');
            return;
        }

        // Enforce per-IP connection limit (proxy-aware)
        const ip = TRUST_PROXY
            ? (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown')
            : (req.socket.remoteAddress ?? 'unknown');
        const currentIpCount = this.ipConnectionCounts.get(ip) ?? 0;
        if (currentIpCount >= WS_MAX_CONNECTIONS_PER_IP) {
            ws.close(1013, 'Too many connections from this IP');
            console.warn(`[WebSocket] Rejected connection from ${ip} — per-IP limit (${WS_MAX_CONNECTIONS_PER_IP}) reached`);
            return;
        }
        this.ipConnectionCounts.set(ip, currentIpCount + 1);
        this.clientIps.set(ws, ip);

        const origin = req.headers['origin'] ?? 'unknown';
        console.log(`[WebSocket] Client connected from ${origin} (${ip}, ${this.wss.clients.size} total)`);

        // Mark alive for ping/pong keepalive
        const tagged = ws as WebSocket & { isAlive?: boolean };
        tagged.isAlive = true;
        ws.on('pong', () => {
            tagged.isAlive = true;
        });

        // Send connection acknowledgement (no swap data until client subscribes).
        // Previously sent all active swaps to every anonymous connection — removed for privacy.
        const initMsg: IWsMessage = { type: 'connected', data: { message: 'Subscribe to a swap to receive updates' } };
        this.sendToClient(ws, initMsg);

        ws.on('message', (raw: Buffer | string) => {
            this.handleClientMessage(ws, raw);
        });

        ws.on('close', () => {
            this.removeClientFromAllSubscriptions(ws);
            // Decrement per-IP counter
            const clientIp = this.clientIps.get(ws);
            if (clientIp) {
                const count = this.ipConnectionCounts.get(clientIp) ?? 1;
                if (count <= 1) {
                    this.ipConnectionCounts.delete(clientIp);
                } else {
                    this.ipConnectionCounts.set(clientIp, count - 1);
                }
            }
            console.log(`[WebSocket] Client disconnected (${this.wss.clients.size} remaining)`);
        });

        ws.on('error', (err: Error) => {
            console.error(`[WebSocket] Client error: ${err.message}`);
        });
    }

    /** Checks per-connection message rate limit. Returns true if allowed. */
    private checkWsRateLimit(ws: WebSocket): boolean {
        const now = Date.now();
        let state = this.clientRates.get(ws);
        if (!state || now - state.windowStart > WS_MSG_RATE_WINDOW_MS) {
            state = { msgCount: 1, windowStart: now };
            this.clientRates.set(ws, state);
            return true;
        }
        state.msgCount++;
        return state.msgCount <= WS_MSG_RATE_LIMIT;
    }

    /** Removes expired entries from pendingPreimages (both memory and DB). */
    private sweepExpiredPreimages(): void {
        const now = Date.now();
        let swept = 0;
        for (const [swapId, entry] of this.pendingPreimages) {
            if (now - entry.storedAt > PENDING_PREIMAGE_TTL_MS) {
                this.pendingPreimages.delete(swapId);
                this.storage.deletePendingPreimage(swapId);
                swept++;
            }
        }
        if (swept > 0) {
            console.log(`[WebSocket] Swept ${swept} expired pending preimage(s) from memory + DB`);
        }
    }

    private handleClientMessage(ws: WebSocket, raw: Buffer | string): void {
        // Per-connection message rate limiting
        if (!this.checkWsRateLimit(ws)) {
            this.sendToClient(ws, { type: 'error', data: 'Rate limited — slow down' });
            return;
        }

        try {
            const text = typeof raw === 'string' ? raw : raw.toString('utf-8');

            // Reject deeply nested JSON to prevent CPU/memory spikes from crafted payloads.
            // Subscribe messages have depth ≤2, so 5 is generous.
            if (jsonNestingDepth(text) > 5) {
                this.sendToClient(ws, { type: 'error', data: 'Message too deeply nested' });
                return;
            }

            const msg = JSON.parse(text) as IWsClientMessage;

            if (msg.type === 'subscribe' && typeof msg.swapId === 'string') {
                // Check per-connection subscription cap
                const currentCount = this.clientSubCounts.get(ws) ?? 0;
                if (currentCount >= WS_MAX_SUBSCRIPTIONS_PER_CLIENT) {
                    this.sendToClient(ws, { type: 'error', data: 'Maximum subscriptions reached' });
                    return;
                }

                // Validate claim_token before allowing subscription
                const swap = this.storage.getSwap(msg.swapId);
                if (!swap) {
                    this.sendToClient(ws, { type: 'error', data: 'Swap not found' });
                    return;
                }

                // Authenticate via claim_token.
                // Check DB state FIRST to decide auth strategy:
                if (swap.claim_token && swap.claim_token.length > 0) {
                    // DB has a claim_token — require and verify it
                    if (!msg.claimToken || typeof msg.claimToken !== 'string') {
                        this.sendToClient(ws, { type: 'error', data: 'claim_token required' });
                        console.log(`[WebSocket] Rejected subscription for swap ${msg.swapId} — no token provided`);
                        return;
                    }
                    const expected = new TextEncoder().encode(swap.claim_token);
                    const provided = new TextEncoder().encode(msg.claimToken);
                    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
                        this.sendToClient(ws, { type: 'error', data: 'Invalid claim_token' });
                        console.log(`[WebSocket] Rejected subscription for swap ${msg.swapId} — invalid claim_token`);
                        return;
                    }
                } else {
                    // No claim_token in DB (on-chain imported swap) — allow full subscription
                    // including preimage delivery. On-chain TAKEN status is the authorization.
                    console.log(`[WebSocket] No claim_token for swap ${msg.swapId} — on-chain import, granting full access (status: ${swap.status})`);
                }

                // Track whether this client proved claim_token ownership.
                // For on-chain imported swaps (no claim_token in DB), treat all subscribers
                // as authenticated — the on-chain TAKEN status is the authorization.
                const hasClaimToken = !!(swap.claim_token && swap.claim_token.length > 0);
                const isAuthenticated = hasClaimToken || !swap.claim_token;

                let subs = this.subscriptions.get(msg.swapId);
                if (!subs) {
                    subs = new Set();
                    this.subscriptions.set(msg.swapId, subs);
                }
                subs.add(ws);
                this.clientSubCounts.set(ws, currentCount + 1);

                // Only authenticated subscribers can receive preimages
                if (isAuthenticated) {
                    let authSubs = this.authenticatedSubs.get(msg.swapId);
                    if (!authSubs) {
                        authSubs = new Set();
                        this.authenticatedSubs.set(msg.swapId, authSubs);
                    }
                    authSubs.add(ws);
                }

                console.log(`[WebSocket] Client subscribed to swap ${msg.swapId} (${isAuthenticated ? 'authenticated' : 'public-only'})`);

                // Deliver queued preimage ONLY to authenticated subscribers.
                // Check in-memory map first, then fall back to DB (handles eviction + restart).
                if (isAuthenticated) {
                    let pendingPreimage = this.pendingPreimages.get(msg.swapId)?.preimage ?? null;
                    if (!pendingPreimage) {
                        // In-memory map may have evicted — check DB for this specific swap
                        // (single-row query avoids loading/decrypting ALL pending preimages)
                        const dbPreimage = this.storage.loadPendingPreimage(msg.swapId);
                        if (dbPreimage) {
                            pendingPreimage = dbPreimage;
                            // Re-populate in-memory cache
                            this.pendingPreimages.set(msg.swapId, { preimage: dbPreimage, storedAt: Date.now() });
                        }
                    }
                    if (pendingPreimage) {
                        const payload: IWsPreimageReady = { swapId: msg.swapId, preimage: pendingPreimage };
                        const preimageMsg: IWsMessage = { type: 'preimage_ready', data: payload };
                        this.sendToClient(ws, preimageMsg);
                        console.log(`[WebSocket] Delivered queued preimage to late authenticated subscriber for swap ${msg.swapId}`);
                    }
                }
            }
        } catch {
            // Ignore malformed messages
        }
    }

    private removeClientFromAllSubscriptions(ws: WebSocket): void {
        for (const [swapId, subs] of this.subscriptions) {
            subs.delete(ws);
            if (subs.size === 0) {
                this.subscriptions.delete(swapId);
            }
        }
        // Also clean up authenticated subscription tracking
        for (const [swapId, authSubs] of this.authenticatedSubs) {
            authSubs.delete(ws);
            if (authSubs.size === 0) {
                this.authenticatedSubs.delete(swapId);
            }
        }
    }

    private sendToClient(ws: WebSocket, message: IWsMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }
}
