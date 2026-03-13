/**
 * Hook for polling active swaps from the SwapVault contract
 * and combining with coordinator status updates.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { SwapData, CoordinatorStatus } from '../types/swap';
import { getSwapVaultContract, getProvider } from '../services/opnet';
import { getAllCoordinatorStatuses } from '../services/coordinator';

const SWAP_VAULT_ADDRESS = import.meta.env.VITE_SWAP_VAULT_ADDRESS;
const POLL_INTERVAL_MS = 30_000;

export interface UseSwapsResult {
    readonly swaps: SwapData[];
    readonly coordinatorStatuses: CoordinatorStatus[];
    readonly isLoading: boolean;
    readonly error: string | null;
    readonly refresh: () => Promise<void>;
    readonly lastUpdated: Date | null;
}

/**
 * Polls active swaps from the SwapVault contract every 30 seconds.
 * Also fetches coordinator status for each swap.
 */
export function useSwaps(): UseSwapsResult {
    const [swaps, setSwaps] = useState<SwapData[]>([]);
    const [coordinatorStatuses, setCoordinatorStatuses] = useState<CoordinatorStatus[]>([]);
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const mountedRef = useRef<boolean>(true);

    const fetchSwaps = useCallback(async (): Promise<void> => {
        if (!SWAP_VAULT_ADDRESS) {
            setError('Swap vault address not configured');
            setIsLoading(false);
            return;
        }

        try {
            const contract = getSwapVaultContract(SWAP_VAULT_ADDRESS);
            const provider = getProvider();
            const [countResult, currentHeight] = await Promise.all([
                contract.getSwapCount(),
                provider.getBlockNumber(),
            ]);

            if ('error' in countResult) {
                throw new Error(String(countResult.error));
            }

            const blockHeight = typeof currentHeight === 'bigint' ? currentHeight : BigInt(currentHeight ?? 0);
            const count = countResult.properties.count ?? 0n;
            const swapDataArr: SwapData[] = [];

            for (let i = 0n; i < count; i++) {
                try {
                    const result = await contract.getSwap(i);
                    if ('error' in result) continue;

                    const p = result.properties;

                    // Only include non-terminal swaps (OPEN=0, TAKEN=1)
                    if (p.status > 1n) continue;

                    // Skip expired swaps (refund block already passed)
                    if (blockHeight > 0n && p.refundBlock <= blockHeight) continue;

                    const depositorStr = typeof p.depositor === 'object' && p.depositor !== null
                        ? (p.depositor as { toString(): string }).toString()
                        : String(p.depositor);
                    const counterpartyStr = typeof p.counterparty === 'object' && p.counterparty !== null
                        ? (p.counterparty as { toString(): string }).toString()
                        : String(p.counterparty);
                    const tokenAddrStr = typeof p.tokenAddress === 'object' && p.tokenAddress !== null
                        ? (p.tokenAddress as { toString(): string }).toString()
                        : String(p.tokenAddress ?? '');

                    swapDataArr.push({
                        swapId: i,
                        tokenAddress: tokenAddrStr,
                        hashLock: p.hashLock,
                        refundBlock: p.refundBlock,
                        amount: p.amount,
                        xmrAmount: p.xmrAmount,
                        depositor: depositorStr,
                        counterparty: counterpartyStr,
                        status: p.status,
                        xmrAddressHi: p.xmrAddressHi,
                        xmrAddressLo: p.xmrAddressLo,
                    });
                } catch {
                    // Skip individual swap fetch errors
                    continue;
                }
            }

            if (!mountedRef.current) return;
            setSwaps(swapDataArr);
            setError(null);
        } catch (err) {
            if (!mountedRef.current) return;
            setError(err instanceof Error ? err.message : 'Failed to load swaps');
        } finally {
            if (mountedRef.current) {
                setIsLoading(false);
                setLastUpdated(new Date());
            }
        }
    }, []);

    const fetchCoordinatorStatuses = useCallback(async (): Promise<void> => {
        const statuses = await getAllCoordinatorStatuses();
        if (mountedRef.current) {
            setCoordinatorStatuses(statuses);
        }
    }, []);

    const refresh = useCallback(async (): Promise<void> => {
        setIsLoading(true);
        await Promise.all([fetchSwaps(), fetchCoordinatorStatuses()]);
    }, [fetchSwaps, fetchCoordinatorStatuses]);

    useEffect(() => {
        mountedRef.current = true;
        void refresh();

        const interval = setInterval(() => {
            void fetchSwaps();
            void fetchCoordinatorStatuses();
        }, POLL_INTERVAL_MS);

        return () => {
            mountedRef.current = false;
            clearInterval(interval);
        };
    }, [refresh, fetchSwaps, fetchCoordinatorStatuses]);

    return { swaps, coordinatorStatuses, isLoading, error, refresh, lastUpdated };
}

/**
 * Hook for fetching a single swap by ID.
 */
export function useSwap(swapId: bigint | null): {
    readonly swap: SwapData | null;
    readonly isLoading: boolean;
    readonly error: string | null;
    readonly refresh: () => Promise<void>;
} {
    const [swap, setSwap] = useState<SwapData | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const mountedRef = useRef<boolean>(true);

    const fetchSwap = useCallback(async (): Promise<void> => {
        if (swapId === null || !SWAP_VAULT_ADDRESS) return;

        setIsLoading(true);
        try {
            const contract = getSwapVaultContract(SWAP_VAULT_ADDRESS);
            const result = await contract.getSwap(swapId);

            if ('error' in result) {
                throw new Error(String(result.error));
            }

            const p = result.properties;
            const depStr = typeof p.depositor === 'object' && p.depositor !== null
                ? (p.depositor as { toString(): string }).toString()
                : String(p.depositor);
            const cptyStr = typeof p.counterparty === 'object' && p.counterparty !== null
                ? (p.counterparty as { toString(): string }).toString()
                : String(p.counterparty);

            const tokenAddrStr = typeof p.tokenAddress === 'object' && p.tokenAddress !== null
                ? (p.tokenAddress as { toString(): string }).toString()
                : String(p.tokenAddress ?? '');

            const swapData: SwapData = {
                swapId,
                tokenAddress: tokenAddrStr,
                hashLock: p.hashLock,
                refundBlock: p.refundBlock,
                amount: p.amount,
                xmrAmount: p.xmrAmount,
                depositor: depStr,
                counterparty: cptyStr,
                status: p.status,
                xmrAddressHi: p.xmrAddressHi,
                xmrAddressLo: p.xmrAddressLo,
            };

            if (mountedRef.current) {
                setSwap(swapData);
                setError(null);
            }
        } catch (err) {
            if (mountedRef.current) {
                setError(err instanceof Error ? err.message : 'Failed to load swap');
            }
        } finally {
            if (mountedRef.current) {
                setIsLoading(false);
            }
        }
    }, [swapId]);

    useEffect(() => {
        mountedRef.current = true;
        void fetchSwap();

        const interval = setInterval(() => {
            void fetchSwap();
        }, 15_000);

        return () => {
            mountedRef.current = false;
            clearInterval(interval);
        };
    }, [fetchSwap]);

    return { swap, isLoading, error, refresh: fetchSwap };
}

/**
 * Hook for fetching current block number (for timeout calculations).
 */
export function useBlockNumber(): bigint | null {
    const [blockNumber, setBlockNumber] = useState<bigint | null>(null);

    useEffect(() => {
        let mounted = true;

        const fetchBlock = async (): Promise<void> => {
            try {
                const provider = getProvider();
                const block = await provider.getBlockNumber();
                if (mounted && typeof block === 'bigint') {
                    setBlockNumber(block);
                } else if (mounted && typeof block === 'number') {
                    setBlockNumber(BigInt(block));
                }
            } catch {
                // Non-critical, keep last value
            }
        };

        void fetchBlock();
        const interval = setInterval(() => void fetchBlock(), 60_000);

        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, []);

    return blockNumber;
}
