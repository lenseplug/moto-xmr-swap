import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------
export type SwapCreatedEvent = {
    readonly swapId: bigint;
    readonly depositor: Address;
    readonly tokenAddress: Address;
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

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the listToken function call.
 */
export type ListToken = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the delistToken function call.
 */
export type DelistToken = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the createSwap function call.
 */
export type CreateSwap = CallResult<
    {
        swapId: bigint;
    },
    OPNetEvent<SwapCreatedEvent>[]
>;

/**
 * @description Represents the result of the takeSwap function call.
 */
export type TakeSwap = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<SwapTakenEvent>[]
>;

/**
 * @description Represents the result of the claim function call.
 */
export type Claim = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<SwapClaimedEvent>[]
>;

/**
 * @description Represents the result of the refund function call.
 */
export type Refund = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<SwapRefundedEvent>[]
>;

/**
 * @description Represents the result of the getSwap function call.
 */
export type GetSwap = CallResult<
    {
        tokenAddress: Address;
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

/**
 * @description Represents the result of the getActiveSwaps function call.
 */
export type GetActiveSwaps = CallResult<
    {
        swapIds: unknown;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getSwapCount function call.
 */
export type GetSwapCount = CallResult<
    {
        count: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getTotalEscrow function call.
 */
export type GetTotalEscrow = CallResult<
    {
        totalEscrow: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the isListed function call.
 */
export type IsListed = CallResult<
    {
        listed: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getTokenCount function call.
 */
export type GetTokenCount = CallResult<
    {
        count: bigint;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// ISwapVault
// ------------------------------------------------------------------
export interface ISwapVault extends IOP_NETContract {
    listToken(tokenAddress: Address): Promise<ListToken>;
    delistToken(tokenAddress: Address): Promise<DelistToken>;
    createSwap(
        tokenAddress: Address,
        hashLock: bigint,
        refundBlock: bigint,
        amount: bigint,
        xmrAmount: bigint,
        xmrAddressHi: bigint,
        xmrAddressLo: bigint,
    ): Promise<CreateSwap>;
    takeSwap(swapId: bigint): Promise<TakeSwap>;
    claim(swapId: bigint, preimage: bigint): Promise<Claim>;
    refund(swapId: bigint): Promise<Refund>;
    getSwap(swapId: bigint): Promise<GetSwap>;
    getActiveSwaps(): Promise<GetActiveSwaps>;
    getSwapCount(): Promise<GetSwapCount>;
    getTotalEscrow(): Promise<GetTotalEscrow>;
    isListed(tokenAddress: Address): Promise<IsListed>;
    getTokenCount(): Promise<GetTokenCount>;
}
