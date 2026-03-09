/**
 * WebSocket server for real-time swap state updates.
 * Uses the built-in `ws` module via Node.js http.Server upgrade.
 */

import { type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { type ISwapRecord, type IWsMessage, type IWsPreimageReady } from './types.js';
import { StorageService } from './storage.js';

const ALLOWED_ORIGIN = process.env['CORS_ORIGIN'] ?? 'http://localhost:5173';

/** Manages WebSocket connections and state-change broadcasts. */
export class SwapWebSocketServer {
    private readonly wss: WebSocketServer;
    private readonly storage: StorageService;

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
     * @param swap - The updated swap record.
     */
    public broadcastSwapUpdate(swap: ISwapRecord): void {
        const message: IWsMessage = { type: 'swap_update', data: swap };
        this.broadcast(message);
    }

    /**
     * Broadcasts the preimage for a swap that has reached XMR_LOCKED state.
     * This is the ONLY mechanism by which the preimage is delivered to Bob's frontend.
     * It is never exposed via a public HTTP endpoint.
     *
     * @param swapId - The swap ID.
     * @param preimage - The hex-encoded preimage.
     */
    public broadcastPreimageReady(swapId: string, preimage: string): void {
        const payload: IWsPreimageReady = { swapId, preimage };
        const message: IWsMessage = { type: 'preimage_ready', data: payload };
        this.broadcast(message);
        console.log(`[WebSocket] Preimage broadcast for swap ${swapId}`);
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

        ws.on('close', () => {
            console.log(`[WebSocket] Client disconnected (${this.wss.clients.size} remaining)`);
        });

        ws.on('error', (err: Error) => {
            console.error(`[WebSocket] Client error: ${err.message}`);
        });
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
