/**
 * Coordinator REST client for XMR side of the atomic swap.
 * The coordinator handles Monero locking/unlocking off-chain.
 */
import type { CoordinatorHealth, CoordinatorStatus } from '../types/swap';

const COORDINATOR_BASE = import.meta.env.VITE_COORDINATOR_URL;

/**
 * Checks coordinator health.
 */
export async function checkCoordinatorHealth(): Promise<CoordinatorHealth> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/health`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { status: 'error' };
        return (await res.json()) as CoordinatorHealth;
    } catch {
        return { status: 'error' };
    }
}

/**
 * Fetches coordinator status for a specific swap.
 *
 * @param swapId - The swap ID as a decimal string
 */
export async function getCoordinatorSwapStatus(swapId: string): Promise<CoordinatorStatus | null> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/swap/${swapId}`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        return (await res.json()) as CoordinatorStatus;
    } catch {
        return null;
    }
}

/**
 * Notifies the coordinator that a swap has been taken on-chain.
 * This triggers the coordinator to begin locking XMR.
 *
 * @param swapId - The swap ID as a decimal string
 * @param txId - The Bitcoin transaction ID of the takeSwap call
 */
export async function notifySwapTaken(swapId: string, txId: string): Promise<boolean> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/swap/${swapId}/taken`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txId }),
            signal: AbortSignal.timeout(10000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Fetches statuses for all coordinator-tracked swaps.
 */
export async function getAllCoordinatorStatuses(): Promise<CoordinatorStatus[]> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/swaps`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];
        return (await res.json()) as CoordinatorStatus[];
    } catch {
        return [];
    }
}
