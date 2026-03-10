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
import { type ISwapRecord, type IWsMessage, type IWsPreimageReady, type IWsClientMessage } from './types.js';
import { StorageService } from './storage.js';

const ALLOWED_ORIGIN = process.env['CORS_ORIGIN'] ?? 'http://localhost:5173';

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

interface IPendingPreimage {
    readonly preimage: string;
    readonly storedAt: number;
}

/** Per-connection rate limiter state. */
interface IWsRateState {
    msgCount: number;
    windowStart: number;
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
                return origin === ALLOWED_ORIGIN;
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

        console.log('[WebSocket] Server attached to HTTP server');
    }

    /**
     * Broadcasts a swap state update to all connected clients.
     * General swap updates are public — they contain no secrets.
     * @param swap - The updated swap record.
     */
    public broadcastSwapUpdate(swap: ISwapRecord): void {
        // Sanitize: strip secrets from public broadcast
        const sanitized = { ...swap, preimage: null, claim_token: null, alice_view_key: null, bob_view_key: null };
        const message: IWsMessage = { type: 'swap_update', data: sanitized };
        this.broadcast(message);
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
        // Always queue the preimage so late subscribers can receive it
        this.pendingPreimages.set(swapId, { preimage, storedAt: Date.now() });

        const payload: IWsPreimageReady = { swapId, preimage };
        const message: IWsMessage = { type: 'preimage_ready', data: payload };
        const json = JSON.stringify(message);

        const subscribers = this.subscriptions.get(swapId);
        if (!subscribers || subscribers.size === 0) {
            console.log(`[WebSocket] Preimage ready for swap ${swapId} — queued for late subscribers`);
            return;
        }

        let sent = 0;
        for (const client of subscribers) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(json);
                sent++;
            }
        }
        console.log(`[WebSocket] Preimage sent to ${sent} subscriber(s) for swap ${swapId}`);
    }

    /** Removes a queued preimage (e.g., after swap completes or expires). */
    public clearPendingPreimage(swapId: string): void {
        this.pendingPreimages.delete(swapId);
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
        const origin = req.headers['origin'] ?? 'unknown';
        console.log(`[WebSocket] Client connected from ${origin}`);

        // Mark alive for ping/pong keepalive
        const tagged = ws as WebSocket & { isAlive?: boolean };
        tagged.isAlive = true;
        ws.on('pong', () => {
            tagged.isAlive = true;
        });

        const activeSwaps = this.storage.getActiveSwaps();
        // Sanitize: strip secrets from public broadcast
        const sanitized = activeSwaps.map((s) => ({ ...s, preimage: null, claim_token: null, alice_view_key: null, bob_view_key: null }));
        const initMsg: IWsMessage = { type: 'active_swaps', data: sanitized };
        this.sendToClient(ws, initMsg);

        ws.on('message', (raw: Buffer | string) => {
            this.handleClientMessage(ws, raw);
        });

        ws.on('close', () => {
            this.removeClientFromAllSubscriptions(ws);
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

    /** Removes expired entries from pendingPreimages. */
    private sweepExpiredPreimages(): void {
        const now = Date.now();
        let swept = 0;
        for (const [swapId, entry] of this.pendingPreimages) {
            if (now - entry.storedAt > PENDING_PREIMAGE_TTL_MS) {
                this.pendingPreimages.delete(swapId);
                swept++;
            }
        }
        if (swept > 0) {
            console.log(`[WebSocket] Swept ${swept} expired pending preimage(s)`);
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

                // ALWAYS require claim_token. If swap has no token yet
                // (not taken), reject — preimage subscriptions are only
                // for the taker who received the token via POST /take.
                if (!swap.claim_token || swap.claim_token.length === 0) {
                    this.sendToClient(ws, { type: 'error', data: 'Swap has no claim token — not yet taken' });
                    console.log(`[WebSocket] Rejected subscription for swap ${msg.swapId} — no claim_token set`);
                    return;
                }

                if (!msg.claimToken || typeof msg.claimToken !== 'string') {
                    this.sendToClient(ws, { type: 'error', data: 'claim_token required' });
                    console.log(`[WebSocket] Rejected subscription for swap ${msg.swapId} — no token provided`);
                    return;
                }

                // Timing-safe comparison to prevent timing attacks
                const expected = new TextEncoder().encode(swap.claim_token);
                const provided = new TextEncoder().encode(msg.claimToken);
                if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
                    this.sendToClient(ws, { type: 'error', data: 'Invalid claim_token' });
                    console.log(`[WebSocket] Rejected subscription for swap ${msg.swapId} — invalid claim_token`);
                    return;
                }

                let subs = this.subscriptions.get(msg.swapId);
                if (!subs) {
                    subs = new Set();
                    this.subscriptions.set(msg.swapId, subs);
                }
                subs.add(ws);
                this.clientSubCounts.set(ws, currentCount + 1);
                console.log(`[WebSocket] Client subscribed to swap ${msg.swapId} (authenticated)`);

                // Deliver queued preimage if one was broadcast before this client subscribed
                const pending = this.pendingPreimages.get(msg.swapId);
                if (pending) {
                    const payload: IWsPreimageReady = { swapId: msg.swapId, preimage: pending.preimage };
                    const preimageMsg: IWsMessage = { type: 'preimage_ready', data: payload };
                    this.sendToClient(ws, preimageMsg);
                    console.log(`[WebSocket] Delivered queued preimage to late subscriber for swap ${msg.swapId}`);
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
    }

    private broadcast(message: IWsMessage): void {
        const json = JSON.stringify(message);
        let sent = 0;
        this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(json);
                sent++;
            }
        });
        if (sent > 0) {
            console.log(`[WebSocket] Broadcast to ${sent} client(s): ${message.type}`);
        }
    }

    private sendToClient(ws: WebSocket, message: IWsMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    }
}
