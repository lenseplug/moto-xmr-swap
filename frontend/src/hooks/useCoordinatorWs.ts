/**
 * WebSocket hook for real-time coordinator updates.
 * Connects to the coordinator WS endpoint, subscribes to a swap,
 * and receives preimage_ready + swap_update messages.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = (import.meta.env.VITE_COORDINATOR_WS_URL ?? 'ws://localhost:3001');
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;

// In production, block non-WSS WebSocket URL
if (import.meta.env.PROD && WS_URL && !WS_URL.startsWith('wss://')) {
    throw new Error(
        '[SECURITY] Refusing to open WebSocket over ws://. ' +
        'Set VITE_COORDINATOR_WS_URL to a wss:// URL for production builds.',
    );
}

interface WsSwapData {
    readonly swap_id?: string;
    readonly status?: string;
    readonly xmr_address?: string;
    readonly xmr_lock_confirmations?: number;
}

interface WsMessage {
    readonly type: 'swap_update' | 'active_swaps' | 'connected' | 'preimage_ready' | 'queue_update' | 'error';
    readonly data: unknown;
}

interface PreimageReadyPayload {
    readonly swapId: string;
    readonly preimage: string;
}

interface WsQueueEntry {
    readonly swapId: string;
    readonly position: number;
    readonly total: number;
}

interface WsQueueUpdatePayload {
    readonly queue: WsQueueEntry[];
}

export interface QueuePositionInfo {
    readonly position: number;
    readonly total: number;
}

export interface UseCoordinatorWsResult {
    readonly preimage: string | null;
    readonly latestUpdate: WsSwapData | null;
    readonly connected: boolean;
    readonly queuePosition: QueuePositionInfo | null;
}

/**
 * Verifies that SHA-256(preimage) matches the expected hash lock.
 * Prevents accepting a spoofed preimage from a compromised WebSocket.
 */
async function verifyPreimage(preimageHex: string, expectedHashLockHex: string): Promise<boolean> {
    try {
        const preimageBytes = new Uint8Array(preimageHex.length / 2);
        for (let i = 0; i < preimageBytes.length; i++) {
            preimageBytes[i] = parseInt(preimageHex.slice(i * 2, i * 2 + 2), 16);
        }
        const hashBuf = await crypto.subtle.digest('SHA-256', preimageBytes);
        const hashHex = Array.from(new Uint8Array(hashBuf))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        return hashHex === expectedHashLockHex.toLowerCase();
    } catch {
        return false;
    }
}

/**
 * Connects to the coordinator WebSocket, subscribes to a specific swap,
 * and returns the preimage when the coordinator broadcasts it.
 *
 * @param swapId - The swap to subscribe to.
 * @param claimToken - Optional claim_token for authenticated preimage delivery.
 * @param hashLockHex - Optional hash lock to verify received preimages against (64-char hex).
 */
export function useCoordinatorWs(swapId: string | null, claimToken?: string | null, hashLockHex?: string | null): UseCoordinatorWsResult {
    const [preimage, setPreimage] = useState<string | null>(null);
    const [latestUpdate, setLatestUpdate] = useState<WsSwapData | null>(null);
    const [connected, setConnected] = useState(false);
    const [queuePosition, setQueuePosition] = useState<QueuePositionInfo | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const reconnectAttemptRef = useRef(0);
    const mountedRef = useRef(true);
    // Buffer: holds a preimage received before hashLockHex was available for verification.
    const pendingPreimageRef = useRef<string | null>(null);
    // Ref for hashLockHex — prevents WebSocket reconnection thrashing when
    // hashLockHex changes from null to a value (swap data loading).
    // hashLockHex is only used for preimage verification, not for subscription.
    const hashLockRef = useRef(hashLockHex);
    hashLockRef.current = hashLockHex;

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
                reconnectAttemptRef.current = 0;
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
                            // Validate preimage format (64-char hex)
                            if (!/^[0-9a-f]{64}$/i.test(payload.preimage)) {
                                console.error('[WS] Received invalid preimage format — ignoring');
                            } else if (hashLockRef.current) {
                                // Verify SHA-256(preimage) matches the on-chain hash lock
                                void verifyPreimage(payload.preimage, hashLockRef.current).then((valid) => {
                                    if (valid) {
                                        pendingPreimageRef.current = null;
                                        setPreimage(payload.preimage);
                                    } else {
                                        console.error('[WS] Preimage verification FAILED — SHA-256 mismatch. Possible spoofed message.');
                                    }
                                });
                            } else {
                                // hashLockHex not yet available (swap data still loading).
                                // Buffer the preimage so we can verify once hashLockHex arrives.
                                console.warn('[WS] Preimage received before hashLock available — buffering for deferred verification');
                                pendingPreimageRef.current = payload.preimage;
                            }
                        }
                    }

                    if (msg.type === 'swap_update') {
                        const data = msg.data as WsSwapData;
                        if (data.swap_id === swapId) {
                            setLatestUpdate(data);
                        }
                    }

                    if (msg.type === 'queue_update') {
                        const payload = msg.data as WsQueueUpdatePayload;
                        if (payload.queue && Array.isArray(payload.queue)) {
                            const myEntry = payload.queue.find((e) => e.swapId === swapId);
                            setQueuePosition(myEntry ? { position: myEntry.position, total: myEntry.total } : null);
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
                // Auto-reconnect with exponential backoff
                const attempt = reconnectAttemptRef.current++;
                const delay = Math.min(WS_RECONNECT_BASE_MS * Math.pow(2, attempt), WS_RECONNECT_MAX_MS);
                reconnectTimerRef.current = setTimeout(() => {
                    if (mountedRef.current) connect();
                }, delay);
            };

            ws.onerror = () => {
                // onclose will fire after onerror, triggering reconnect
            };
        } catch {
            // Connection failed, try again with backoff
            const attempt = reconnectAttemptRef.current++;
            const delay = Math.min(WS_RECONNECT_BASE_MS * Math.pow(2, attempt), WS_RECONNECT_MAX_MS);
            reconnectTimerRef.current = setTimeout(() => {
                if (mountedRef.current) connect();
            }, delay);
        }
    }, [swapId, claimToken]);

    // Deferred verification: when hashLockHex becomes available and we have a buffered preimage,
    // verify it now. This handles the race where WS delivers preimage before swap data loads.
    useEffect(() => {
        const buffered = pendingPreimageRef.current;
        if (!buffered || !hashLockHex || preimage !== null) return;

        void verifyPreimage(buffered, hashLockHex).then((valid) => {
            if (!mountedRef.current) return;
            if (valid) {
                pendingPreimageRef.current = null;
                setPreimage(buffered);
            } else {
                console.error('[WS] Deferred preimage verification FAILED — SHA-256 mismatch');
                pendingPreimageRef.current = null;
            }
        });
    }, [hashLockHex, preimage]);

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

    return { preimage, latestUpdate, connected, queuePosition };
}
