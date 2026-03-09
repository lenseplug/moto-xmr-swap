/**
 * WebSocket server for real-time swap state updates.
 * Uses the built-in `ws` module via Node.js http.Server upgrade.
 *
 * Preimage messages are ONLY sent to clients that have subscribed to
 * the specific swap ID via a { type: 'subscribe', swapId } message.
 */

import { type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { type ISwapRecord, type IWsMessage, type IWsPreimageReady, type IWsClientMessage } from './types.js';
import { StorageService } from './storage.js';

const ALLOWED_ORIGIN = process.env['CORS_ORIGIN'] ?? 'http://localhost:5173';

/** Manages WebSocket connections and state-change broadcasts. */
export class SwapWebSocketServer {
    private readonly wss: WebSocketServer;
    private readonly storage: StorageService;

    /** Maps swapId → Set of WebSocket clients subscribed to that swap. */
    private readonly subscriptions = new Map<string, Set<WebSocket>>();

    public constructor(httpServer: Server, storage: StorageService) {
        this.storage = storage;
        this.wss = new WebSocketServer({
            server: httpServer,
            verifyClient: ({ origin }: { origin?: string }) => {
                // Allow non-browser clients (scripts, curl) that send no Origin header.
                if (!origin) return true;
                return origin === ALLOWED_ORIGIN;
            },
        });
        this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
            this.handleConnection(ws, req);
        });
        console.log('[WebSocket] Server attached to HTTP server');
    }

    /**
     * Broadcasts a swap state update to all connected clients.
     * General swap updates are public — they contain no secrets.
     * @param swap - The updated swap record.
     */
    public broadcastSwapUpdate(swap: ISwapRecord): void {
        const message: IWsMessage = { type: 'swap_update', data: swap };
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
        const payload: IWsPreimageReady = { swapId, preimage };
        const message: IWsMessage = { type: 'preimage_ready', data: payload };
        const json = JSON.stringify(message);

        const subscribers = this.subscriptions.get(swapId);
        if (!subscribers || subscribers.size === 0) {
            console.log(`[WebSocket] Preimage ready for swap ${swapId} but no subscribers`);
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

    /**
     * Broadcasts an error message to all connected clients.
     * @param message - The error message string.
     */
    public broadcastError(message: string): void {
        const msg: IWsMessage = { type: 'error', data: message };
        this.broadcast(msg);
    }

    /** Returns the count of currently connected clients. */
    public get clientCount(): number {
        return this.wss.clients.size;
    }

    /** Gracefully closes the WebSocket server. */
    public close(): void {
        this.wss.close();
    }

    private handleConnection(ws: WebSocket, req: IncomingMessage): void {
        const origin = req.headers['origin'] ?? 'unknown';
        console.log(`[WebSocket] Client connected from ${origin}`);

        const activeSwaps = this.storage.getActiveSwaps();
        const initMsg: IWsMessage = { type: 'active_swaps', data: activeSwaps };
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

    private handleClientMessage(ws: WebSocket, raw: Buffer | string): void {
        try {
            const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
            const msg = JSON.parse(text) as IWsClientMessage;

            if (msg.type === 'subscribe' && typeof msg.swapId === 'string') {
                let subs = this.subscriptions.get(msg.swapId);
                if (!subs) {
                    subs = new Set();
                    this.subscriptions.set(msg.swapId, subs);
                }
                subs.add(ws);
                console.log(`[WebSocket] Client subscribed to swap ${msg.swapId}`);
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
