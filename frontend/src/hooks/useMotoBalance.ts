/**
 * Polls MOTO token balance for the connected wallet.
 */
import { useState, useEffect, useRef } from 'react';
import type { Address } from '@btc-vision/transaction';
import { getMotoContract, formatTokenAmount } from '../services/opnet';

const MOTO_TOKEN_ADDRESS = import.meta.env.VITE_MOTO_TOKEN_ADDRESS;
const POLL_INTERVAL_MS = 30_000;

interface MotoBalanceResult {
    balance: bigint | null;
    formatted: string;
    isLoading: boolean;
}

export function useMotoBalance(senderAddress: Address | null): MotoBalanceResult {
    const [balance, setBalance] = useState<bigint | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;

        if (!senderAddress || !MOTO_TOKEN_ADDRESS) {
            setBalance(null);
            return;
        }

        let timer: ReturnType<typeof setInterval> | null = null;

        const fetchBalance = async (): Promise<void> => {
            try {
                setIsLoading(true);
                const contract = getMotoContract(MOTO_TOKEN_ADDRESS, senderAddress);
                const result = await contract.balanceOf(senderAddress);
                if (!mountedRef.current) return;
                if ('error' in result) {
                    console.warn('[useMotoBalance] balanceOf error:', result.error);
                    return;
                }
                setBalance(result.properties.balance);
            } catch (err) {
                console.warn('[useMotoBalance] fetch error:', err);
            } finally {
                if (mountedRef.current) setIsLoading(false);
            }
        };

        void fetchBalance();
        timer = setInterval(() => void fetchBalance(), POLL_INTERVAL_MS);

        return () => {
            mountedRef.current = false;
            if (timer) clearInterval(timer);
        };
    }, [senderAddress]);

    return {
        balance,
        formatted: balance !== null ? formatTokenAmount(balance) : '—',
        isLoading,
    };
}
