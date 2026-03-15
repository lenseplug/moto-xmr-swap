/**
 * Coordinator REST client for XMR side of the atomic swap.
 * The coordinator handles Monero locking/unlocking off-chain.
 */
import type { BobKeyMaterial, CoordinatorHealth, CoordinatorStatus } from '../types/swap';

const COORDINATOR_BASE = import.meta.env.VITE_COORDINATOR_URL;

/** Validates that a swap ID is a non-negative integer string before URL interpolation. */
function sanitizeSwapId(swapId: string): string {
    if (!/^\d+$/.test(swapId)) {
        throw new Error(`Invalid swap ID: ${swapId}`);
    }
    return swapId;
}

// In production builds, warn about non-HTTPS coordinator URL
if (import.meta.env.PROD && COORDINATOR_BASE && !COORDINATOR_BASE.startsWith('https://')) {
    console.warn(
        '[SECURITY] VITE_COORDINATOR_URL should use https:// in production. ' +
        'Secrets sent over HTTP can be intercepted by network attackers.',
    );
}

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

/** Maps coordinator SwapStatus enum to frontend step keys. */
const STATUS_TO_STEP: Record<string, CoordinatorStatus['step']> = {
    OPEN: 'created',
    TAKEN: 'taken',
    XMR_LOCKING: 'xmr_locking',
    XMR_LOCKED: 'xmr_locked',
    MOTO_CLAIMING: 'claimed',
    COMPLETED: 'complete',
    REFUNDED: 'refunded',
    EXPIRED: 'error',
};

/** Coordinator API swap record shape (snake_case). */
interface ICoordinatorSwapFields {
    readonly swap_id: string;
    readonly status: string;
    readonly hash_lock: string;
    readonly xmr_lock_tx: string | null;
    readonly xmr_address: string | null;
    readonly xmr_lock_confirmations: number;
    readonly xmr_fee: string;
    readonly xmr_total: string;
    readonly trustless_mode: number;
    readonly alice_ed25519_pub: string | null;
    readonly bob_ed25519_pub: string | null;
    readonly sweep_status: string | null;
    readonly depositor: string;
    readonly updated_at: string;
}

interface ICoordinatorSwapResponse {
    readonly success: boolean;
    readonly data: {
        readonly swap: ICoordinatorSwapFields;
    } | null;
}

/**
 * Fetches coordinator status for a specific swap.
 * Transforms the coordinator's snake_case API response to the frontend's CoordinatorStatus type.
 *
 * @param swapId - The swap ID as a decimal string
 */
export async function getCoordinatorSwapStatus(swapId: string): Promise<CoordinatorStatus | null> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${sanitizeSwapId(swapId)}`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as ICoordinatorSwapResponse;
        if (!body.success || !body.data) return null;

        const swap = body.data.swap;
        const step = STATUS_TO_STEP[swap.status] ?? 'error';

        return {
            swapId: swap.swap_id,
            step,
            message: `Status: ${swap.status}`,
            xmrTxId: swap.xmr_lock_tx ?? undefined,
            xmrFee: swap.xmr_fee,
            xmrTotal: swap.xmr_total,
            xmrLockAddress: swap.xmr_address ?? undefined,
            xmrLockConfirmations: swap.xmr_lock_confirmations,
            trustlessMode: swap.trustless_mode === 1,
            aliceEd25519Pub: swap.alice_ed25519_pub ?? undefined,
            bobEd25519Pub: swap.bob_ed25519_pub ?? undefined,
            sweepStatus: swap.sweep_status ?? undefined,
            depositor: swap.depositor,
            updatedAt: new Date(swap.updated_at).getTime(),
        };
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
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${sanitizeSwapId(swapId)}/take`, {
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

/** Coordinator list swaps API response shape. */
interface ICoordinatorListResponse {
    readonly success: boolean;
    readonly data: {
        readonly swaps: ReadonlyArray<ICoordinatorSwapFields>;
    } | null;
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
        const body = (await res.json()) as ICoordinatorListResponse;
        if (!body.success || !body.data) return [];

        return body.data.swaps.map((swap) => {
            const step = STATUS_TO_STEP[swap.status] ?? 'error';
            return {
                swapId: swap.swap_id,
                step,
                message: `Status: ${swap.status}`,
                xmrTxId: swap.xmr_lock_tx ?? undefined,
                xmrFee: swap.xmr_fee,
                xmrTotal: swap.xmr_total,
                xmrLockAddress: swap.xmr_address ?? undefined,
                xmrLockConfirmations: swap.xmr_lock_confirmations,
                trustlessMode: swap.trustless_mode === 1,
                aliceEd25519Pub: swap.alice_ed25519_pub ?? undefined,
                bobEd25519Pub: swap.bob_ed25519_pub ?? undefined,
                sweepStatus: swap.sweep_status ?? undefined,
                depositor: swap.depositor,
                updatedAt: new Date(swap.updated_at).getTime(),
            };
        });
    } catch {
        return [];
    }
}

/**
 * Resolves the actual on-chain swap ID by matching hashLock.
 * Needed because the simulated swap ID may differ from the on-chain ID
 * if another swap was mined between simulation and confirmation.
 *
 * @param hashLock - The 64-char hex hash lock to search for
 * @returns The matching swap_id string, or null if not found
 */
export async function resolveSwapIdByHashLock(hashLock: string): Promise<string | null> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as ICoordinatorListResponse;
        if (!body.success || !body.data) return null;

        const needle = hashLock.toLowerCase();
        const match = body.data.swaps.find((s) => s.hash_lock.toLowerCase() === needle);
        return match?.swap_id ?? null;
    } catch {
        return null;
    }
}

/**
 * Submits the swap secret (preimage) to the coordinator.
 * The coordinator verifies SHA-256(secret) matches the on-chain hash lock.
 *
 * @param swapId - The swap ID as a decimal string
 * @param secret - The 64-char hex preimage
 * @param aliceViewKey - Optional Alice view key for split-key mode (64 hex chars)
 * @returns true if the secret was accepted
 */
export async function submitSwapSecret(swapId: string, secret: string, aliceViewKey?: string, aliceXmrPayout?: string): Promise<{ ok: boolean; error?: string }> {
    try {
        const body: Record<string, string> = { secret };
        if (aliceViewKey) {
            body['aliceViewKey'] = aliceViewKey;
        }
        if (aliceXmrPayout) {
            body['aliceXmrPayout'] = aliceXmrPayout;
        }
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${sanitizeSwapId(swapId)}/secret`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: `${res.status}: ${text}` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
    }
}

/**
 * Submits Bob's key material for a split-key swap.
 *
 * @param swapId - The swap ID as a decimal string
 * @param keys - Bob's ed25519 public key, view key, and key proof-of-knowledge
 * @returns true if the keys were accepted
 */
export async function submitBobKeys(swapId: string, keys: BobKeyMaterial, claimToken?: string): Promise<boolean> {
    try {
        const body: Record<string, string> = { ...keys };
        if (claimToken) {
            body['claimToken'] = claimToken;
        }
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${sanitizeSwapId(swapId)}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Alice triggers XMR claim (sweep from lock address to her payout address).
 *
 * @param swapId - The swap ID as a decimal string
 * @returns Result with ok status and optional error message
 */
export async function claimXmr(swapId: string): Promise<{ ok: boolean; error?: string }> {
    try {
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${sanitizeSwapId(swapId)}/claim-xmr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
            return { ok: false, error: body.error?.message ?? `HTTP ${res.status}` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
    }
}
