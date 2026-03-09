import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

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
        outputs: [{ name: 'swapIds', type: ABIDataTypes.UINT256_ARRAY }],
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

export default SwapVaultAbi;
