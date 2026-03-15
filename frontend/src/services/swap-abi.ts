/**
 * SwapVault ABI and typed interface for use with getContract().
 */
import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI, IOP_NETContract, CallResult, OPNetEvent } from 'opnet';
import type { Address } from '@btc-vision/transaction';

export const SwapVaultEvents = [
    {
        name: 'SwapCreated',
        values: [
            { name: 'swapId', type: ABIDataTypes.UINT256 },
            { name: 'depositor', type: ABIDataTypes.ADDRESS },
            { name: 'hashLock', type: ABIDataTypes.UINT256 },
            { name: 'refundBlock', type: ABIDataTypes.UINT256 },
            { name: 'amount', type: ABIDataTypes.UINT256 },
            { name: 'xmrAmount', type: ABIDataTypes.UINT256 },
            { name: 'xmrAddressHi', type: ABIDataTypes.UINT256 },
            { name: 'xmrAddressLo', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Event,
    },
    {
        name: 'SwapTaken',
        values: [
            { name: 'swapId', type: ABIDataTypes.UINT256 },
            { name: 'counterparty', type: ABIDataTypes.ADDRESS },
        ],
        type: BitcoinAbiTypes.Event,
    },
    {
        name: 'SwapClaimed',
        values: [
            { name: 'swapId', type: ABIDataTypes.UINT256 },
            { name: 'counterparty', type: ABIDataTypes.ADDRESS },
            { name: 'preimage', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Event,
    },
    {
        name: 'SwapRefunded',
        values: [
            { name: 'swapId', type: ABIDataTypes.UINT256 },
            { name: 'depositor', type: ABIDataTypes.ADDRESS },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Event,
    },
];

export const SwapVaultAbi = [
    {
        name: 'createSwap',
        inputs: [
            { name: 'hashLock', type: ABIDataTypes.UINT256 },
            { name: 'refundBlock', type: ABIDataTypes.UINT256 },
            { name: 'amount', type: ABIDataTypes.UINT256 },
            { name: 'xmrAmount', type: ABIDataTypes.UINT256 },
            { name: 'xmrAddressHi', type: ABIDataTypes.UINT256 },
            { name: 'xmrAddressLo', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'swapId', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'takeSwap',
        inputs: [{ name: 'swapId', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'claim',
        inputs: [
            { name: 'swapId', type: ABIDataTypes.UINT256 },
            { name: 'preimage', type: ABIDataTypes.UINT256 },
        ],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'cancel',
        inputs: [{ name: 'swapId', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'refund',
        inputs: [{ name: 'swapId', type: ABIDataTypes.UINT256 }],
        outputs: [{ name: 'success', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getSwap',
        inputs: [{ name: 'swapId', type: ABIDataTypes.UINT256 }],
        outputs: [
            { name: 'hashLock', type: ABIDataTypes.UINT256 },
            { name: 'refundBlock', type: ABIDataTypes.UINT256 },
            { name: 'amount', type: ABIDataTypes.UINT256 },
            { name: 'xmrAmount', type: ABIDataTypes.UINT256 },
            { name: 'depositor', type: ABIDataTypes.ADDRESS },
            { name: 'counterparty', type: ABIDataTypes.ADDRESS },
            { name: 'status', type: ABIDataTypes.UINT256 },
            { name: 'xmrAddressHi', type: ABIDataTypes.UINT256 },
            { name: 'xmrAddressLo', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getActiveSwaps',
        inputs: [],
        outputs: [{ name: 'swapIds', type: ABIDataTypes.ARRAY_OF_UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getSwapCount',
        inputs: [],
        outputs: [{ name: 'count', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getTotalEscrow',
        inputs: [],
        outputs: [{ name: 'totalEscrow', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    ...SwapVaultEvents,
    ...OP_NET_ABI,
];

export type SwapCreatedEvent = {
    readonly swapId: bigint;
    readonly depositor: Address;
    readonly hashLock: bigint;
    readonly refundBlock: bigint;
    readonly amount: bigint;
    readonly xmrAmount: bigint;
    readonly xmrAddressHi: bigint;
    readonly xmrAddressLo: bigint;
};

export type SwapTakenEvent = {
    readonly swapId: bigint;
    readonly counterparty: Address;
};

export type SwapClaimedEvent = {
    readonly swapId: bigint;
    readonly counterparty: Address;
    readonly preimage: bigint;
};

export type SwapRefundedEvent = {
    readonly swapId: bigint;
    readonly depositor: Address;
    readonly amount: bigint;
};

export type CreateSwapResult = CallResult<
    { swapId: bigint },
    OPNetEvent<SwapCreatedEvent>[]
>;

export type TakeSwapResult = CallResult<
    { success: boolean },
    OPNetEvent<SwapTakenEvent>[]
>;

export type ClaimResult = CallResult<
    { success: boolean },
    OPNetEvent<SwapClaimedEvent>[]
>;

export type CancelResult = CallResult<
    { success: boolean },
    OPNetEvent<SwapRefundedEvent>[]
>;

export type RefundResult = CallResult<
    { success: boolean },
    OPNetEvent<SwapRefundedEvent>[]
>;

export type GetSwapResult = CallResult<
    {
        hashLock: bigint;
        refundBlock: bigint;
        amount: bigint;
        xmrAmount: bigint;
        depositor: Address;
        counterparty: Address;
        status: bigint;
        xmrAddressHi: bigint;
        xmrAddressLo: bigint;
    },
    OPNetEvent<never>[]
>;

export type GetActiveSwapsResult = CallResult<
    { swapIds: bigint[] },
    OPNetEvent<never>[]
>;

export type GetSwapCountResult = CallResult<
    { count: bigint },
    OPNetEvent<never>[]
>;

export type GetTotalEscrowResult = CallResult<
    { totalEscrow: bigint },
    OPNetEvent<never>[]
>;

export interface ISwapVault extends IOP_NETContract {
    /** Resolves the contract's on-chain Address object (async getter on BaseContract). */
    readonly contractAddress: Promise<Address>;
    createSwap(
        hashLock: bigint,
        refundBlock: bigint,
        amount: bigint,
        xmrAmount: bigint,
        xmrAddressHi: bigint,
        xmrAddressLo: bigint,
    ): Promise<CreateSwapResult>;
    takeSwap(swapId: bigint): Promise<TakeSwapResult>;
    claim(swapId: bigint, preimage: bigint): Promise<ClaimResult>;
    cancel(swapId: bigint): Promise<CancelResult>;
    refund(swapId: bigint): Promise<RefundResult>;
    getSwap(swapId: bigint): Promise<GetSwapResult>;
    getActiveSwaps(): Promise<GetActiveSwapsResult>;
    getSwapCount(): Promise<GetSwapCountResult>;
    getTotalEscrow(): Promise<GetTotalEscrowResult>;
}

export default SwapVaultAbi;
