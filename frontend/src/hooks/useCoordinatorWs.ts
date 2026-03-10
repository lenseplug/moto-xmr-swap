/**
 * WebSocket hook for real-time coordinator updates.
 * Connects to the coordinator WS endpoint, subscribes to a swap,
 * and receives preimage_ready + swap_update messages.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = import.meta.env.VITE_COORDINATOR_WS_URL ?? 'ws://localhost:3001';
const RECONNECT_DELAY_MS = 3000;

interface WsSwapData {
    readonly swap_id?: string;
    readonly status?: string;
    readonly xmr_address?: string;
    readonly xmr_lock_confirmations?: number;
}

interface WsMessage {
    readonly type: 'swap_update' | 'active_swaps' | 'preimage_ready' | 'error';
    readonly data: unknown;
}

interface PreimageReadyPayload {
    readonly swapId: string;
    readonly preimage: string;
}

export interface UseCoordinatorWsResult {
    readonly preimage: string | null;
    readonly latestUpdate: WsSwapData | null;
    readonly connected: boolean;
}

/**
 * Connects to the coordinator WebSocket, subscribes to a specific swap,
 * and returns the preimage when the coordinator broadcasts it.
 *
 * @param swapId - The swap to subscribe to.
 * @param claimToken - Optional claim_token for authenticated preimage delivery.
 */
export function useCoordinatorWs(swapId: string | null, claimToken?: string | null): UseCoordinatorWsResult {
    const [preimage, setPreimage] = useState<string | null>(null);
    const [latestUpdate, setLatestUpdate] = useState<WsSwapData | null>(null);
    const [connected, setConnected] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    const connect = useCallback(() => {
        if (!swapId || !mountedRef.current) return;

        // Clean up existing connection
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }

        try {
            const ws = new WebSocket(WS_URL);
            wsRef.current = ws;

            ws.onopen = () => {
                if (!mountedRef.current) return;
                setConnected(true);
                // Subscribe to this swap with optional claim_token for auth
                const msg: Record<string, string> = { type: 'subscribe', swapId };
                if (claimToken) {
                    msg['claimToken'] = claimToken;
                }
                ws.send(JSON.stringify(msg));
            };

            ws.onmessage = (event: MessageEvent) => {
                if (!mountedRef.current) return;
                try {
                    const msg = JSON.parse(event.data as string) as WsMessage;

                    if (msg.type === 'preimage_ready') {
                        const payload = msg.data as PreimageReadyPayload;
                        if (payload.swapId === swapId && payload.preimage) {
                            setPreimage(payload.preimage);
                        }
                    }

                    if (msg.type === 'swap_update') {
                        const data = msg.data as WsSwapData;
                        if (data.swap_id === swapId) {
                            setLatestUpdate(data);
                        }
                    }
                } catch {
                    // Ignore malformed messages
                }
            };

            ws.onclose = () => {
                if (!mountedRef.current) return;
                setConnected(false);
                wsRef.current = null;
                // Auto-reconnect
                reconnectTimerRef.current = setTimeout(() => {
                    if (mountedRef.current) connect();
                }, RECONNECT_DELAY_MS);
            };

            ws.onerror = () => {
                // onclose will fire after onerror, triggering reconnect
            };
        } catch {
            // Connection failed, try again
            reconnectTimerRef.current = setTimeout(() => {
                if (mountedRef.current) connect();
            }, RECONNECT_DELAY_MS);
        }
    }, [swapId, claimToken]);

    useEffect(() => {
        mountedRef.current = true;
        connect();

        return () => {
            mountedRef.current = false;
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [connect]);

    return { preimage, latestUpdate, connected };
}
