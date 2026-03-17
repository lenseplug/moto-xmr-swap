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

// In production builds, block non-HTTPS coordinator URL
if (import.meta.env.PROD && COORDINATOR_BASE && !COORDINATOR_BASE.startsWith('https://')) {
    throw new Error(
        '[SECURITY] Refusing to send secrets over HTTP. ' +
        'Set VITE_COORDINATOR_URL to an https:// URL for production builds.',
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
    TAKE_PENDING: 'take_pending',
    TAKEN: 'taken',
    XMR_LOCKING: 'xmr_locking',
    XMR_LOCKED: 'xmr_locked',
    XMR_SWEEPING: 'xmr_sweeping',
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
    readonly alice_secp256k1_pub: string | null;
    readonly alice_dleq_proof: string | null;
    readonly bob_secp256k1_pub: string | null;
    readonly bob_dleq_proof: string | null;
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
            aliceSecp256k1Pub: swap.alice_secp256k1_pub ?? undefined,
            aliceDleqProof: swap.alice_dleq_proof ?? undefined,
            bobSecp256k1Pub: swap.bob_secp256k1_pub ?? undefined,
            bobDleqProof: swap.bob_dleq_proof ?? undefined,
            sweepStatus: swap.sweep_status ?? undefined,
            depositor: swap.depositor,
            preimage: swap.preimage ?? undefined,
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
 * claimTokenHint is REQUIRED — deterministically derived from Bob's mnemonic via HKDF.
 */
export async function notifySwapTaken(swapId: string, txId: string, claimTokenHint: string, bobXmrRefund?: string): Promise<TakeSwapResult> {
    try {
        const bodyObj: Record<string, string> = { opnetTxId: txId, claimTokenHint };
        if (bobXmrRefund) bodyObj['bobXmrRefund'] = bobXmrRefund;
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${sanitizeSwapId(swapId)}/take`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyObj),
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
                aliceSecp256k1Pub: swap.alice_secp256k1_pub ?? undefined,
                aliceDleqProof: swap.alice_dleq_proof ?? undefined,
                bobSecp256k1Pub: swap.bob_secp256k1_pub ?? undefined,
                bobDleqProof: swap.bob_dleq_proof ?? undefined,
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

/** Result of a swap lookup — distinguishes network errors from not-found. */
export interface LookupResult {
    swapId: string | null;
    error?: 'network' | 'not_found';
}

/**
 * Looks up a swap by its hashLock hex (used for Alice recovery).
 * Distinguishes network errors from "not found" so the UI can show the right message.
 */
export async function lookupSwapByHashLock(hashLockHex: string): Promise<LookupResult> {
    // Validate hex format before URL interpolation (defense-in-depth)
    if (!/^[0-9a-f]{64}$/i.test(hashLockHex)) {
        return { swapId: null, error: 'not_found' };
    }
    try {
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/by-hashlock/${hashLockHex}`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
            // Fallback: scan all swaps
            const fallback = await resolveSwapIdByHashLock(hashLockHex);
            return { swapId: fallback, error: fallback ? undefined : 'not_found' };
        }
        const body = (await res.json()) as { success: boolean; data?: { swap_id?: string } };
        const swapId = body.data?.swap_id ?? null;
        return { swapId, error: swapId ? undefined : 'not_found' };
    } catch {
        // Network error — don't silently treat as "not found"
        return { swapId: null, error: 'network' };
    }
}

/**
 * Pre-registers a secret backup with the coordinator before the swap exists on-chain.
 * This ensures the recovery_token is stored server-side and applied to the swap record.
 */
export async function backupSecret(
    hashLock: string,
    secret: string,
    recoveryToken: string,
    aliceViewKey?: string,
    aliceXmrPayout?: string,
): Promise<{ ok: boolean; error?: string }> {
    try {
        const body: Record<string, string> = { hashLock, secret, recoveryToken };
        if (aliceViewKey) body['aliceViewKey'] = aliceViewKey;
        if (aliceXmrPayout) body['aliceXmrPayout'] = aliceXmrPayout;
        const res = await fetch(`${COORDINATOR_BASE}/api/secrets/backup`, {
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
 * Submits the swap secret (preimage) to the coordinator.
 */
export async function submitSwapSecret(
    swapId: string,
    secret: string,
    recoveryToken: string,
    aliceViewKey?: string,
    aliceXmrPayout?: string,
    aliceSecp256k1Pub?: string,
    aliceDleqProof?: string,
): Promise<{ ok: boolean; error?: string }> {
    try {
        const body: Record<string, string> = { secret };
        if (aliceViewKey) {
            body['aliceViewKey'] = aliceViewKey;
        }
        if (aliceXmrPayout) {
            body['aliceXmrPayout'] = aliceXmrPayout;
        }
        if (aliceSecp256k1Pub) {
            body['aliceSecp256k1Pub'] = aliceSecp256k1Pub;
        }
        if (aliceDleqProof) {
            body['aliceDleqProof'] = aliceDleqProof;
        }
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/${sanitizeSwapId(swapId)}/secret`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Recovery-Token': recoveryToken,
            },
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

