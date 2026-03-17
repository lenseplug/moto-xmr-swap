/**
 * Swap status enum matching contract values.
 * 0 = OPEN, 1 = TAKEN, 2 = CLAIMED, 3 = REFUNDED
 */
export const SwapStatus = {
    OPEN: 0n,
    TAKEN: 1n,
    CLAIMED: 2n,
    REFUNDED: 3n,
} as const;

export type SwapStatusValue = (typeof SwapStatus)[keyof typeof SwapStatus];

/**
 * Display labels for swap status values.
 */
export const SWAP_STATUS_LABELS: Record<string, string> = {
    '0': 'Open',
    '1': 'Taken',
    '2': 'Claimed',
    '3': 'Refunded',
};

/**
 * Raw on-chain swap data returned from getSwap().
 */
export interface SwapData {
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

/**
 * Extended swap data with computed display fields.
 */
export interface SwapDisplayData extends SwapData {
    readonly motoAmount: string;
    readonly xmrDisplayAmount: string;
    readonly statusLabel: string;
    readonly xmrAddress: string;
    readonly blocksRemaining: bigint;
    readonly isExpired: boolean;
}

/**
 * Parameters for creating a new swap.
 */
export interface CreateSwapParams {
    readonly hashLock: bigint;
    readonly refundBlock: bigint;
    readonly amount: bigint;
    readonly xmrAmount: bigint;
    readonly xmrAddressHi: bigint;
    readonly xmrAddressLo: bigint;
}

/**
 * Coordinator status update for a swap.
 */
export interface CoordinatorStatus {
    readonly swapId: string;
    readonly step:
        | 'created'
        | 'take_pending'
        | 'taken'
        | 'xmr_locking'
        | 'xmr_locked'
        | 'xmr_sweeping'
        | 'claimed'
        | 'complete'
        | 'refunded'
        | 'error';
    readonly message: string;
    readonly xmrTxId?: string;
    readonly xmrFee?: string;
    readonly xmrTotal?: string;
    readonly xmrLockAddress?: string;
    readonly xmrLockConfirmations?: number;
    readonly trustlessMode?: boolean;
    readonly aliceEd25519Pub?: string;
    readonly bobEd25519Pub?: string;
    readonly aliceSecp256k1Pub?: string;
    readonly aliceDleqProof?: string;
    readonly bobSecp256k1Pub?: string;
    readonly bobDleqProof?: string;
    readonly sweepStatus?: string;
    readonly depositor?: string;
    readonly preimage?: string;
    readonly updatedAt: number;
}

/** Swap fee in basis points (0.87%). */
export const FEE_BPS = 87n;

/** Basis-point denominator. */
const BPS_DENOMINATOR = 10_000n;

/**
 * Calculates the XMR taker fee from an on-chain xmrAmount (piconero bigint).
 * fee = (amount * 87) / 10000
 */
export function calculateXmrFee(xmrAmount: bigint): bigint {
    return (xmrAmount * FEE_BPS) / BPS_DENOMINATOR;
}

/**
 * Calculates xmrAmount + fee.
 */
export function calculateXmrTotal(xmrAmount: bigint): bigint {
    return xmrAmount + calculateXmrFee(xmrAmount);
}

/**
 * Bob's key material for coordinator-mediated atomic swap.
 */
export interface BobKeyMaterial {
    readonly bobEd25519PubKey: string;
    readonly bobViewKey: string;
    readonly bobKeyProof: string;
    readonly bobSpendKey: string;
    readonly bobSecp256k1Pub?: string;
    readonly bobDleqProof?: string;
}

/**
 * Coordinator health response.
 */
export interface CoordinatorHealth {
    readonly status: 'ok' | 'error';
    readonly version?: string;
}

/**
 * Sort field for order book.
 */
export type SortField = 'motoAmount' | 'xmrAmount' | 'rate' | 'blocksRemaining';
export type SortDirection = 'asc' | 'desc';

export interface SortState {
    readonly field: SortField;
    readonly direction: SortDirection;
}
