/**
 * Shared types for the MOTO-XMR Coordinator.
 */

/** Swap fee in basis points (0.87% = 87 bps). Paid by the taker on the XMR side. */
export const FEE_BPS = 87;

/** Basis-point denominator. */
const BPS_DENOMINATOR = 10_000n;

/** Minimum XMR amount in piconero (0.025 XMR = 25,000,000,000 piconero).
 *  At 0.87% fee, this yields ~217.5M piconero dev fee.
 *  After 80M network fee deduction, ~137.5M goes to fee wallet. */
export const MIN_XMR_AMOUNT_PICONERO = 25_000_000_000n;

/** Regex matching a valid non-negative integer string (no leading zeros except "0" itself). */
const VALID_AMOUNT_RE = /^(0|[1-9]\d*)$/;

/**
 * Safely parses an amount string to BigInt.
 * Returns null if the string is not a valid non-negative integer.
 */
export function safeParseAmount(value: string): bigint | null {
    if (!VALID_AMOUNT_RE.test(value)) return null;
    return BigInt(value);
}

/**
 * Calculates the XMR fee for a given amount in atomic units (piconero string).
 * fee = (amount * FEE_BPS) / 10000
 *
 * @param xmrAmount - XMR amount as a decimal string of atomic units.
 * @returns The fee as a decimal string of atomic units.
 * @throws if xmrAmount is not a valid positive integer string.
 */
export function calculateXmrFee(xmrAmount: string): string {
    const amount = safeParseAmount(xmrAmount);
    if (amount === null || amount <= 0n) {
        throw new Error(`Invalid XMR amount: must be a positive integer string, got "${xmrAmount}"`);
    }
    const fee = (amount * BigInt(FEE_BPS)) / BPS_DENOMINATOR;
    return fee.toString();
}

/**
 * Calculates XMR amount + fee.
 *
 * @param xmrAmount - XMR amount as a decimal string of atomic units.
 * @returns The total (amount + fee) as a decimal string.
 * @throws if xmrAmount is not a valid positive integer string.
 */
export function calculateXmrTotal(xmrAmount: string): string {
    const amount = safeParseAmount(xmrAmount);
    if (amount === null || amount <= 0n) {
        throw new Error(`Invalid XMR amount: must be a positive integer string, got "${xmrAmount}"`);
    }
    const fee = (amount * BigInt(FEE_BPS)) / BPS_DENOMINATOR;
    return (amount + fee).toString();
}

/** All possible states of a swap in the coordinator state machine. */
export enum SwapStatus {
    OPEN = 'OPEN',
    TAKEN = 'TAKEN',
    XMR_LOCKING = 'XMR_LOCKING',
    XMR_LOCKED = 'XMR_LOCKED',
    MOTO_CLAIMING = 'MOTO_CLAIMING',
    COMPLETED = 'COMPLETED',
    EXPIRED = 'EXPIRED',
    REFUNDED = 'REFUNDED',
}

/** Terminal states — no further transitions possible. */
export const TERMINAL_STATES: ReadonlySet<SwapStatus> = new Set([
    SwapStatus.COMPLETED,
    SwapStatus.REFUNDED,
]);

/**
 * Settled states — swaps that should not appear in active listings or be
 * resumed on restart. Includes TERMINAL_STATES plus EXPIRED (which can
 * only transition to REFUNDED via on-chain refund confirmation).
 */
export const SETTLED_STATES: ReadonlySet<SwapStatus> = new Set([
    SwapStatus.COMPLETED,
    SwapStatus.REFUNDED,
    SwapStatus.EXPIRED,
]);

/** A swap record as stored in SQLite and returned by the API. */
export interface ISwapRecord {
    readonly id: number;
    readonly swap_id: string;
    readonly hash_lock: string;
    readonly preimage: string | null;
    readonly refund_block: number;
    readonly moto_amount: string;
    readonly xmr_amount: string;
    readonly xmr_fee: string;
    readonly xmr_total: string;
    readonly xmr_address: string | null;
    readonly depositor: string;
    readonly counterparty: string | null;
    readonly status: SwapStatus;
    readonly opnet_create_tx: string | null;
    readonly opnet_claim_tx: string | null;
    readonly opnet_refund_tx: string | null;
    readonly xmr_lock_tx: string | null;
    readonly xmr_lock_confirmations: number;
    readonly xmr_subaddr_index: number | null;
    readonly claim_token: string | null;
    /** Split-key mode: swap uses cross-curve key exchange for shared Monero address. Coordinator is trusted with XMR. */
    readonly trustless_mode: number;
    /** Alice's ed25519 public spend key (64 hex chars). Derived from preimage in split-key mode. */
    readonly alice_ed25519_pub: string | null;
    /** Alice's ed25519 private view key (64 hex chars). */
    readonly alice_view_key: string | null;
    /** Bob's ed25519 public spend key (64 hex chars). */
    readonly bob_ed25519_pub: string | null;
    /** Bob's ed25519 private view key (64 hex chars). */
    readonly bob_view_key: string | null;
    /** Bob's ed25519 private spend key (64 hex chars). Needed for sweep. */
    readonly bob_spend_key: string | null;
    /** Bob's DLEQ proof (hex). */
    readonly bob_dleq_proof: string | null;
    /** Alice's XMR payout address (where her XMR portion is sent after completion). */
    readonly alice_xmr_payout: string | null;
    /** Sweep status: null = not attempted, 'pending' = queued, 'done' = swept, 'failed:reason' = error. */
    readonly sweep_status: string | null;
    readonly created_at: string;
    readonly updated_at: string;
}

/** Fields used when creating a new swap record. */
export interface ICreateSwapParams {
    readonly swap_id: string;
    readonly hash_lock: string;
    readonly refund_block: number;
    readonly moto_amount: string;
    readonly xmr_amount: string;
    readonly xmr_fee: string;
    readonly xmr_total: string;
    readonly xmr_address: string | null;
    readonly depositor: string;
    readonly opnet_create_tx: string | null;
    readonly alice_xmr_payout: string | null;
}

/** Fields that can be updated on an existing swap. */
export interface IUpdateSwapParams {
    readonly status?: SwapStatus;
    readonly preimage?: string | null;
    readonly counterparty?: string;
    readonly opnet_claim_tx?: string;
    readonly opnet_refund_tx?: string;
    readonly xmr_lock_tx?: string;
    readonly xmr_lock_confirmations?: number;
    readonly xmr_address?: string;
    readonly xmr_subaddr_index?: number;
    readonly claim_token?: string | null;
    readonly trustless_mode?: number;
    readonly alice_ed25519_pub?: string;
    readonly alice_view_key?: string | null;
    readonly bob_ed25519_pub?: string;
    readonly bob_view_key?: string | null;
    readonly bob_spend_key?: string | null;
    readonly bob_dleq_proof?: string;
    readonly alice_xmr_payout?: string;
    readonly sweep_status?: string | null;
}

/** A state history entry. */
export interface IStateHistoryEntry {
    readonly id: number;
    readonly swap_id: string;
    readonly from_state: string;
    readonly to_state: string;
    readonly timestamp: string;
    readonly metadata: string | null;
}

/** Preimage + hash lock pair generated by the Monero module. */
export interface IPreimageResult {
    readonly preimage: string;
    readonly hashLock: string;
}

/** Result of checking a Monero lock address. */
export interface IMonitorLockResult {
    readonly confirmations: number;
    readonly confirmed: boolean;
}

/** On-chain swap data returned by the OPNet watcher. */
export interface IOnChainSwap {
    readonly swapId: bigint;
    readonly hashLock: bigint;
    readonly refundBlock: bigint;
    readonly amount: bigint;
    readonly xmrAmount: bigint;
    readonly depositor: string;
    readonly counterparty: string;
    readonly status: bigint;
    readonly xmrAddressHi: bigint;
    readonly xmrAddressLo: bigint;
}

/** Preimage-ready WebSocket message payload. */
export interface IWsPreimageReady {
    readonly swapId: string;
    readonly preimage: string;
}

/** Incoming WebSocket message from client. */
export interface IWsClientMessage {
    readonly type: 'subscribe';
    readonly swapId: string;
    readonly claimToken?: string;
}

/** Queue position info broadcast via WebSocket. */
export interface IWsQueueUpdate {
    readonly queue: ReadonlyArray<{ readonly swapId: string; readonly position: number; readonly total: number }>;
}

/** WebSocket message shape. */
export interface IWsMessage {
    readonly type: 'swap_update' | 'active_swaps' | 'error' | 'preimage_ready' | 'queue_update';
    readonly data: ISwapRecord | ISwapRecord[] | string | IWsPreimageReady | IWsQueueUpdate;
}

/** Structured API response wrapper. */
export interface IApiResponse<T> {
    readonly success: boolean;
    readonly data: T | null;
    readonly error: IApiError | null;
}

/** Structured API error. */
export interface IApiError {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
}

/** Pagination query params. */
export interface IPaginationParams {
    readonly page: number;
    readonly limit: number;
}

/** Request body for POST /api/swaps/:id/take */
export interface ITakeSwapBody {
    readonly opnetTxId: string;
}
