/**
 * Hook for fetching and caching the list of supported tokens
 * from the coordinator API.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { ITokenRecord } from '../types/swap';
import { fetchTokens } from '../services/coordinator';

/** Fallback MOTO token if coordinator is unavailable. */
const MOTO_TOKEN_ADDRESS = import.meta.env.VITE_MOTO_TOKEN_ADDRESS ?? '';
const FALLBACK_TOKENS: ITokenRecord[] = MOTO_TOKEN_ADDRESS
    ? [{
        address: MOTO_TOKEN_ADDRESS,
        symbol: 'MOTO',
        name: 'MOTO Token',
        decimals: 18,
        listed: true,
    }]
    : [];

export interface UseTokensResult {
    readonly tokens: ITokenRecord[];
    readonly isLoading: boolean;
    readonly error: string | null;
    readonly refresh: () => Promise<void>;
    /** Find a token by address. */
    readonly getToken: (address: string) => ITokenRecord | undefined;
}

/**
 * Fetches supported tokens from the coordinator on mount.
 * Falls back to MOTO if the coordinator is unreachable.
 */
export function useTokens(): UseTokensResult {
    const [tokens, setTokens] = useState<ITokenRecord[]>(FALLBACK_TOKENS);
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const mountedRef = useRef<boolean>(true);

    const refresh = useCallback(async (): Promise<void> => {
        setIsLoading(true);
        try {
            const result = await fetchTokens();
            if (!mountedRef.current) return;
            if (result.length > 0) {
                setTokens(result.filter((t) => t.listed));
                setError(null);
            } else {
                // Keep fallback tokens, show no error (coordinator may just not have tokens endpoint yet)
                setTokens(FALLBACK_TOKENS);
            }
        } catch (err) {
            if (!mountedRef.current) return;
            setError(err instanceof Error ? err.message : 'Failed to load tokens');
            setTokens(FALLBACK_TOKENS);
        } finally {
            if (mountedRef.current) {
                setIsLoading(false);
            }
        }
    }, []);

    const getToken = useCallback(
        (address: string): ITokenRecord | undefined => {
            return tokens.find(
                (t) => t.address.toLowerCase() === address.toLowerCase(),
            );
        },
        [tokens],
    );

    useEffect(() => {
        mountedRef.current = true;
        void refresh();
        return () => {
            mountedRef.current = false;
        };
    }, [refresh]);

    return { tokens, isLoading, error, refresh, getToken };
}
