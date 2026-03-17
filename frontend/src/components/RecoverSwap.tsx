/**
 * RecoverSwap — dedicated tab for recovering a swap from 12 words.
 * User enters mnemonic + selects role (Alice/Bob) -> derives keys -> finds swap.
 */
import React, { useState, useCallback } from 'react';
import { MnemonicInput } from './MnemonicInput';
import { deriveAliceKeys, deriveBobKeys } from '../utils/mnemonic';
import { lookupSwapByHashLock } from '../services/coordinator';
import { useSwapSession } from '../contexts/SwapSessionContext';

interface RecoverSwapProps {
    readonly onRecovered: (swapId: bigint) => void;
}

export function RecoverSwap({ onRecovered }: RecoverSwapProps): React.ReactElement {
    const { setSession } = useSwapSession();
    const [role, setRole] = useState<'alice' | 'bob'>('alice');
    const [swapIdInput, setSwapIdInput] = useState<string>('');
    const [status, setStatus] = useState<'idle' | 'searching' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = useCallback(async (mnemonic: string) => {
        setStatus('searching');
        setError(null);

        try {
            if (role === 'alice') {
                const aliceKeys = await deriveAliceKeys(mnemonic);

                // If swap ID provided, go directly to SwapStatus (handles on-chain imports)
                if (swapIdInput.trim()) {
                    setSession({
                        swapId: swapIdInput.trim(),
                        role: 'alice',
                        mnemonic: '',
                        aliceKeys,
                        bobKeys: null,
                    });
                    onRecovered(BigInt(swapIdInput.trim()));
                    return;
                }

                // Look up swap by hashLock
                const result = await lookupSwapByHashLock(aliceKeys.hashLockHex);
                if (result.error === 'network') {
                    setError('Cannot reach the coordinator — please check your connection and try again.');
                    setStatus('error');
                    return;
                }
                const swapId = result.swapId;
                if (!swapId) {
                    setError('No swap found with this mnemonic. Try entering the Swap ID manually.');
                    setStatus('error');
                    return;
                }

                setSession({
                    swapId,
                    role: 'alice',
                    mnemonic: '',
                    aliceKeys,
                    bobKeys: null,
                });
                onRecovered(BigInt(swapId));
            } else {
                const bobKeys = await deriveBobKeys(mnemonic);

                // If swap ID provided, go directly to SwapStatus (handles on-chain imports)
                if (swapIdInput.trim()) {
                    setSession({
                        swapId: swapIdInput.trim(),
                        role: 'bob',
                        mnemonic: '',
                        aliceKeys: null,
                        bobKeys,
                    });
                    onRecovered(BigInt(swapIdInput.trim()));
                    return;
                }

                // For Bob, we derive the claim token and look up via coordinator
                const bobResult = await lookupSwapByClaimToken(bobKeys.claimTokenHex);
                if (bobResult.error === 'network') {
                    setError('Cannot reach the coordinator — please check your connection and try again.');
                    setStatus('error');
                    return;
                }
                const swapId = bobResult.swapId;
                if (!swapId) {
                    setError('No swap found with this mnemonic. Try entering the Swap ID manually.');
                    setStatus('error');
                    return;
                }

                setSession({
                    swapId,
                    role: 'bob',
                    mnemonic: '',
                    aliceKeys: null,
                    bobKeys,
                });
                onRecovered(BigInt(swapId));
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Recovery failed');
            setStatus('error');
        }
    }, [role, swapIdInput, setSession, onRecovered]);

    return (
        <div style={{ maxWidth: '560px' }}>
            <div style={{ marginBottom: '24px' }}>
                <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '6px' }}>
                    Recover Swap
                </h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                    Enter your 12 recovery words to restore access to a swap. Use this if you closed your browser tab,
                    refreshed the page, or are continuing from a different device.
                </p>
            </div>

            <div className="glass-card" style={{ padding: '24px' }}>
                <div style={{ marginBottom: '20px' }}>
                    <label
                        style={{
                            display: 'block',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            color: 'var(--color-text-secondary)',
                            marginBottom: '8px',
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                        }}
                    >
                        Your Role
                    </label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            className={`btn ${role === 'alice' ? 'btn-primary' : 'btn-ghost'} btn-sm`}
                            onClick={() => setRole('alice')}
                        >
                            Alice (Creator)
                        </button>
                        <button
                            className={`btn ${role === 'bob' ? 'btn-primary' : 'btn-ghost'} btn-sm`}
                            onClick={() => setRole('bob')}
                        >
                            Bob (Taker)
                        </button>
                    </div>
                </div>

                <div style={{ marginBottom: '20px' }}>
                    <label
                        style={{
                            display: 'block',
                            fontSize: '0.8rem',
                            fontWeight: 600,
                            color: 'var(--color-text-secondary)',
                            marginBottom: '8px',
                            letterSpacing: '0.04em',
                            textTransform: 'uppercase',
                        }}
                    >
                        Swap ID (optional)
                    </label>
                    <input
                        type="text"
                        value={swapIdInput}
                        onChange={(e) => setSwapIdInput(e.target.value.replace(/\D/g, ''))}
                        placeholder="e.g. 0"
                        style={{
                            width: '100%',
                            padding: '10px 14px',
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid var(--color-border-subtle)',
                            borderRadius: 'var(--radius-md)',
                            color: 'var(--color-text-primary)',
                            fontSize: '0.9rem',
                        }}
                    />
                    <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                        Enter the swap ID if automatic lookup fails.
                    </p>
                </div>

                <MnemonicInput
                    onSubmit={(m) => void handleSubmit(m)}
                    submitLabel={status === 'searching' ? 'Searching...' : 'Recover Swap'}
                />

                {error && (
                    <div
                        style={{
                            marginTop: '16px',
                            padding: '12px 14px',
                            background: 'rgba(255, 82, 82, 0.08)',
                            border: '1px solid rgba(255, 82, 82, 0.25)',
                            borderRadius: 'var(--radius-md)',
                            color: 'var(--color-text-error)',
                            fontSize: '0.875rem',
                        }}
                    >
                        {error}
                    </div>
                )}
            </div>
        </div>
    );
}

interface LookupResult {
    swapId: string | null;
    error?: 'network' | 'not_found';
}

/**
 * Tries to find a swap matching Bob's deterministic claim token.
 * Distinguishes network errors from 404 so the UI can show the right message.
 */
async function lookupSwapByClaimToken(claimTokenHex: string): Promise<LookupResult> {
    // Validate hex format before URL interpolation (defense-in-depth)
    if (!/^[0-9a-f]{64}$/i.test(claimTokenHex)) {
        return { swapId: null, error: 'not_found' };
    }
    const COORDINATOR_BASE = import.meta.env.VITE_COORDINATOR_URL;
    try {
        const res = await fetch(`${COORDINATOR_BASE}/api/swaps/by-claim-token/${claimTokenHex}`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return { swapId: null, error: 'not_found' };
        const body = (await res.json()) as { success: boolean; data?: { swap_id?: string } };
        const swapId = body.data?.swap_id ?? null;
        return { swapId, error: swapId ? undefined : 'not_found' };
    } catch {
        return { swapId: null, error: 'network' };
    }
}
