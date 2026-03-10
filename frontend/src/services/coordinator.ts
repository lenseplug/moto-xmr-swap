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
        const res = await fetch(`${COORDINATOR_BASE}/api/health`, {
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
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${swapId}`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        return (await res.json()) as CoordinatorStatus;
    } catch {
        return null;
    }
}

/**
 * Result of notifying the coordinator about a taken swap.
 */
export interface TakeSwapResult {
    readonly ok: boolean;
    readonly claimToken: string | null;
}

/**
 * Notifies the coordinator that a swap has been taken on-chain.
 * This triggers the coordinator to begin locking XMR.
 * Returns the claim_token for authenticated WebSocket subscription.
 *
 * @param swapId - The swap ID as a decimal string
 * @param txId - The Bitcoin transaction ID of the takeSwap call
 */
export async function notifySwapTaken(swapId: string, txId: string): Promise<TakeSwapResult> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${swapId}/take`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ opnetTxId: txId }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return { ok: false, claimToken: null };
        const body = (await res.json()) as { data?: { claim_token?: string } };
        const claimToken = body.data?.claim_token ?? null;
        return { ok: true, claimToken };
    } catch {
        return { ok: false, claimToken: null };
    }
}

/**
 * Fetches statuses for all coordinator-tracked swaps.
 */
export async function getAllCoordinatorStatuses(): Promise<CoordinatorStatus[]> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return [];
        return (await res.json()) as CoordinatorStatus[];
    } catch {
        return [];
    }
}

/**
 * Submits the swap secret (preimage) to the coordinator.
 * The coordinator verifies SHA-256(secret) matches the on-chain hash lock.
 *
 * @param swapId - The swap ID as a decimal string
 * @param secret - The 64-char hex preimage
 * @returns true if the secret was accepted
 */
export async function submitSwapSecret(swapId: string, secret: string): Promise<boolean> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${swapId}/secret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret }),
            signal: AbortSignal.timeout(10000),
        });
        return res.ok;
    } catch {
        return false;
    }
}
