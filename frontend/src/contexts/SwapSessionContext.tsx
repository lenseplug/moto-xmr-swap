/**
 * SwapSessionContext — holds in-memory swap keys derived from mnemonic.
 * Lost on page refresh by design — user re-enters their 12 words.
 */
import React, { createContext, useContext, useState, useCallback } from 'react';
import type { AliceSwapKeys, BobSwapKeys } from '../utils/mnemonic';

export interface SwapSession {
    readonly swapId: string;
    readonly role: 'alice' | 'bob';
    readonly mnemonic: string;
    readonly aliceKeys: AliceSwapKeys | null;
    readonly bobKeys: BobSwapKeys | null;
}

interface SwapSessionContextValue {
    readonly session: SwapSession | null;
    readonly setSession: (session: SwapSession | null) => void;
    readonly clearSession: () => void;
}

const SwapSessionCtx = createContext<SwapSessionContextValue>({
    session: null,
    setSession: () => {},
    clearSession: () => {},
});

export function SwapSessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
    const [session, setSessionState] = useState<SwapSession | null>(null);

    const setSession = useCallback((s: SwapSession | null) => {
        setSessionState(s);
    }, []);

    const clearSession = useCallback(() => {
        setSessionState(null);
    }, []);

    return (
        <SwapSessionCtx.Provider value={{ session, setSession, clearSession }}>
            {children}
        </SwapSessionCtx.Provider>
    );
}

export function useSwapSession(): SwapSessionContextValue {
    return useContext(SwapSessionCtx);
}
