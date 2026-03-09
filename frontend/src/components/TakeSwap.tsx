/**
 * TakeSwap component — shows swap details and allows counterparty to take the swap.
 */
import React, { useState, useCallback } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { Address } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { getSwapVaultContract, formatTokenAmount, formatXmrAmount } from '../services/opnet';
import { joinXmrAddress } from '../services/opnet';
import { notifySwapTaken } from '../services/coordinator';
import { useSwap, useBlockNumber } from '../hooks/useSwaps';
import { SWAP_STATUS_LABELS } from '../types/swap';
import { ExplorerLinks } from './ExplorerLinks';
import { SkeletonBlock } from './SkeletonRow';

const SWAP_VAULT_ADDRESS = import.meta.env.VITE_SWAP_VAULT_ADDRESS;

interface TakeSwapProps {
    readonly swapId: bigint;
    readonly onBack: () => void;
    readonly onTaken: (swapId: bigint) => void;
}

/**
 * TakeSwap view — displays swap details and the "Take Swap" action.
 */
export function TakeSwap({ swapId, onBack, onTaken }: TakeSwapProps): React.ReactElement {
    const { publicKey, hashedMLDSAKey, walletAddress } = useWalletConnect();
    const isConnected = publicKey !== null;
    const { swap, isLoading, error: loadError } = useSwap(swapId);
    const currentBlock = useBlockNumber();

    const [step, setStep] = useState<'idle' | 'taking' | 'done' | 'error'>('idle');
    const [txId, setTxId] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const handleTake = useCallback(async (): Promise<void> => {
        if (!isConnected || !walletAddress || !publicKey || !hashedMLDSAKey) {
            setErrorMsg('Connect your wallet first');
            return;
        }

        if (!SWAP_VAULT_ADDRESS) {
            setErrorMsg('Contract address not configured');
            return;
        }

        if (swap === null) {
            setErrorMsg('Swap data not loaded');
            return;
        }

        if (swap.status !== 0n) {
            setErrorMsg('Swap is not in OPEN status');
            return;
        }

        setStep('taking');
        setErrorMsg(null);

        try {
            const senderAddress = Address.fromString(hashedMLDSAKey, publicKey);
            const contract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);

            const sim = await contract.takeSwap(swapId);
            if ('error' in sim) {
                throw new Error(`Simulation failed: ${String(sim.error)}`);
            }

            const receipt = await sim.sendTransaction({
                signer: null,
                mldsaSigner: null,
                linkMLDSAPublicKeyToAddress: true,
                refundTo: walletAddress,
                maximumAllowedSatToSpend: 150_000n,
                network: networks.testnet,
            });

            const receiptObj = receipt as unknown as Record<string, unknown>;
            if ('error' in receiptObj) {
                throw new Error(`Transaction failed: ${String(receiptObj['error'])}`);
            }

            const resultTxId =
                typeof receiptObj['result'] === 'string'
                    ? receiptObj['result']
                    : typeof receiptObj['txid'] === 'string'
                      ? receiptObj['txid']
                      : 'pending';

            setTxId(resultTxId);

            // Notify coordinator to begin XMR locking
            void notifySwapTaken(swapId.toString(), resultTxId);

            setStep('done');
            onTaken(swapId);
        } catch (err) {
            setStep('error');
            setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
        }
    }, [isConnected, walletAddress, publicKey, hashedMLDSAKey, swap, swapId, onTaken]);

    const blocksLeft =
        swap !== null && currentBlock !== null && swap.refundBlock > currentBlock
            ? swap.refundBlock - currentBlock
            : null;

    const isExpired = swap !== null && currentBlock !== null && swap.refundBlock <= currentBlock;

    const detailRow = (label: string, value: React.ReactNode): React.ReactElement => (
        <div
            style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '12px 0',
                borderBottom: '1px solid var(--color-border-subtle)',
            }}
        >
            <span
                style={{
                    fontSize: '0.82rem',
                    color: 'var(--color-text-secondary)',
                    fontWeight: 500,
                }}
            >
                {label}
            </span>
            <span
                style={{
                    fontSize: '0.9rem',
                    color: 'var(--color-text-primary)',
                    fontFamily: 'var(--font-mono)',
                    textAlign: 'right',
                }}
                className="tabular-nums"
            >
                {value}
            </span>
        </div>
    );

    return (
        <div style={{ maxWidth: '520px' }}>
            <button
                className="btn btn-ghost btn-sm"
                onClick={onBack}
                style={{ marginBottom: '20px' }}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="19" y1="12" x2="5" y2="12" />
                    <polyline points="12 19 5 12 12 5" />
                </svg>
                Back to Order Book
            </button>

            <div style={{ marginBottom: '20px' }}>
                <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '4px' }}>
                    Take Swap
                </h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                    Swap ID:{' '}
                    <span className="font-mono" style={{ color: 'var(--color-text-accent)' }}>
                        {swapId.toString()}
                    </span>
                </p>
            </div>

            {loadError !== null && (
                <div
                    style={{
                        padding: '14px',
                        background: 'rgba(255, 82, 82, 0.08)',
                        border: '1px solid rgba(255, 82, 82, 0.25)',
                        borderRadius: 'var(--radius-md)',
                        color: 'var(--color-text-error)',
                        marginBottom: '16px',
                    }}
                >
                    {loadError}
                </div>
            )}

            <div className="glass-card" style={{ padding: '24px' }}>
                {isLoading ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <SkeletonBlock height={32} />
                        <SkeletonBlock height={32} />
                        <SkeletonBlock height={32} />
                        <SkeletonBlock height={32} />
                    </div>
                ) : swap !== null ? (
                    <>
                        <div style={{ marginBottom: '4px' }}>
                            {detailRow(
                                'MOTO You Receive',
                                <span style={{ color: 'var(--color-text-success)', fontWeight: 700 }}>
                                    {formatTokenAmount(swap.amount)} MOTO
                                </span>,
                            )}
                            {detailRow(
                                'XMR You Provide',
                                <span style={{ color: 'var(--color-text-warning)', fontWeight: 700 }}>
                                    {formatXmrAmount(swap.xmrAmount)} XMR
                                </span>,
                            )}
                            {detailRow(
                                'Status',
                                <span style={{ textTransform: 'capitalize' }}>
                                    {SWAP_STATUS_LABELS[swap.status.toString()] ?? 'Unknown'}
                                </span>,
                            )}
                            {detailRow(
                                'Blocks Remaining',
                                <span
                                    style={{
                                        color: isExpired
                                            ? 'var(--color-text-error)'
                                            : blocksLeft !== null && blocksLeft < 20n
                                              ? 'var(--color-text-warning)'
                                              : 'var(--color-text-primary)',
                                    }}
                                >
                                    {isExpired ? 'Expired' : blocksLeft !== null ? blocksLeft.toString() : 'Loading...'}
                                </span>,
                            )}
                            {detailRow('Depositor', swap.depositor.slice(0, 16) + '...' + swap.depositor.slice(-8))}
                            {detailRow(
                                'XMR Destination',
                                <span style={{ fontSize: '0.75rem' }}>
                                    {joinXmrAddress(swap.xmrAddressHi, swap.xmrAddressLo).slice(0, 20)}...
                                </span>,
                            )}
                        </div>

                        {!isConnected && (
                            <div
                                style={{
                                    padding: '12px',
                                    background: 'rgba(255, 215, 64, 0.06)',
                                    border: '1px solid rgba(255, 215, 64, 0.2)',
                                    borderRadius: 'var(--radius-md)',
                                    color: 'var(--color-text-warning)',
                                    fontSize: '0.875rem',
                                    marginTop: '16px',
                                }}
                            >
                                Connect your wallet to take this swap.
                            </div>
                        )}

                        {step === 'taking' && (
                            <div
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '10px',
                                    padding: '12px 14px',
                                    background: 'rgba(0, 229, 255, 0.06)',
                                    border: '1px solid var(--color-border-default)',
                                    borderRadius: 'var(--radius-md)',
                                    fontSize: '0.875rem',
                                    color: 'var(--color-text-accent)',
                                    marginTop: '16px',
                                }}
                            >
                                <div
                                    style={{
                                        width: '6px',
                                        height: '6px',
                                        borderRadius: '50%',
                                        background: 'var(--color-cyan)',
                                    }}
                                />
                                Waiting for wallet signature...
                            </div>
                        )}

                        {errorMsg !== null && (
                            <div
                                style={{
                                    padding: '12px 14px',
                                    background: 'rgba(255, 82, 82, 0.08)',
                                    border: '1px solid rgba(255, 82, 82, 0.25)',
                                    borderRadius: 'var(--radius-md)',
                                    color: 'var(--color-text-error)',
                                    fontSize: '0.875rem',
                                    marginTop: '16px',
                                }}
                            >
                                {errorMsg}
                            </div>
                        )}

                        {step === 'done' && txId !== null && (
                            <div
                                style={{
                                    padding: '16px',
                                    background: 'rgba(0, 230, 118, 0.06)',
                                    border: '1px solid rgba(0, 230, 118, 0.2)',
                                    borderRadius: 'var(--radius-md)',
                                    marginTop: '16px',
                                }}
                            >
                                <p
                                    style={{
                                        fontWeight: 600,
                                        color: 'var(--color-text-success)',
                                        marginBottom: '4px',
                                    }}
                                >
                                    Swap Taken
                                </p>
                                <p style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>
                                    The coordinator is being notified to lock XMR. Monitor the swap status.
                                </p>
                                <ExplorerLinks txId={txId} address={walletAddress ?? undefined} />
                            </div>
                        )}

                        {step !== 'done' && swap.status === 0n && !isExpired && (
                            <button
                                className="btn btn-primary btn-lg"
                                style={{ width: '100%', marginTop: '20px' }}
                                disabled={!isConnected || step === 'taking'}
                                onClick={() => void handleTake()}
                            >
                                {step === 'taking' ? 'Taking Swap...' : 'Take Swap'}
                            </button>
                        )}

                        {(swap.status !== 0n || isExpired) && step !== 'done' && (
                            <p
                                style={{
                                    textAlign: 'center',
                                    marginTop: '16px',
                                    color: 'var(--color-text-muted)',
                                    fontSize: '0.875rem',
                                }}
                            >
                                {isExpired ? 'This swap has expired.' : 'This swap is no longer available.'}
                            </p>
                        )}
                    </>
                ) : (
                    <p style={{ color: 'var(--color-text-muted)', textAlign: 'center' }}>
                        Swap not found.
                    </p>
                )}
            </div>
        </div>
    );
}
