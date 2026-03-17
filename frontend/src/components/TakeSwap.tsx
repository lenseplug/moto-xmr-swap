/**
 * TakeSwap component — shows swap details and allows counterparty to take the swap.
 * Uses BIP39 mnemonic for key derivation — zero localStorage.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { networks } from '@btc-vision/bitcoin';
import { getSwapVaultContract, formatTokenAmount, formatXmrAmount } from '../services/opnet';
import { joinXmrAddress } from '../services/opnet';
import { notifySwapTaken, submitBobKeys } from '../services/coordinator';
import { generateSwapMnemonic, deriveBobKeys } from '../utils/mnemonic';
import { signBobKeyProof } from '../utils/ed25519';
import { uint8ArrayToHex, hexToUint8Array } from '../utils/hashlock';
import { useSwapSession } from '../contexts/SwapSessionContext';
import { useSwap, useBlockNumber } from '../hooks/useSwaps';
import { SWAP_STATUS_LABELS, calculateXmrFee, calculateXmrTotal } from '../types/swap';
import { MnemonicDisplay } from './MnemonicDisplay';
import { ExplorerLinks } from './ExplorerLinks';
import { SkeletonBlock } from './SkeletonRow';

const SWAP_VAULT_ADDRESS = import.meta.env.VITE_SWAP_VAULT_ADDRESS;

interface TakeSwapProps {
    readonly swapId: bigint;
    readonly onBack: () => void;
    readonly onTaken: (swapId: bigint) => void;
}

export function TakeSwap({ swapId, onBack, onTaken }: TakeSwapProps): React.ReactElement {
    const { publicKey, address: senderAddress, walletAddress } = useWalletConnect();
    const { setSession } = useSwapSession();
    const isConnected = publicKey !== null;
    const { swap, isLoading, error: loadError } = useSwap(swapId);
    const currentBlock = useBlockNumber();

    const [step, setStep] = useState<'idle' | 'mnemonic' | 'taking' | 'done' | 'error'>('idle');
    const [statusMessage, setStatusMessage] = useState<string>('');
    const [txId, setTxId] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [mnemonic, setMnemonic] = useState<string | null>(null);
    const [bobXmrRefund, setBobXmrRefund] = useState<string>('');

    // Warn user before closing/navigating away during mnemonic step.
    // Losing the mnemonic means losing access to swap funds.
    useEffect(() => {
        if (step !== 'mnemonic') return;
        const handler = (e: BeforeUnloadEvent): void => {
            e.preventDefault();
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [step]);

    // Step 1: Generate mnemonic and show it
    const handleStartTake = useCallback((): void => {
        if (!isConnected || !walletAddress || !publicKey || !senderAddress) {
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

        const words = generateSwapMnemonic();
        setMnemonic(words);
        setStep('mnemonic');
        setErrorMsg(null);
    }, [isConnected, walletAddress, publicKey, senderAddress, swap]);

    // Step 2: User confirmed words -> proceed with on-chain tx
    const handleMnemonicConfirmed = useCallback(async (): Promise<void> => {
        if (!mnemonic || !senderAddress || !walletAddress) return;
        if (!SWAP_VAULT_ADDRESS) return;

        setStep('taking');
        setErrorMsg(null);
        setStatusMessage('Deriving swap keys from mnemonic...');

        try {
            // Pass hashLock to bind DLEQ proof to this specific swap (prevents cross-swap replay)
            const swapHashLock = swap ? swap.hashLock.toString(16).padStart(64, '0') : undefined;
            const bobKeys = await deriveBobKeys(mnemonic, swapHashLock);

            setStatusMessage('Simulating take transaction...');

            const contract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);

            const sim = await contract.takeSwap(swapId);
            if ('error' in sim) {
                throw new Error(`Simulation failed: ${String(sim.error)}`);
            }

            setStatusMessage('Waiting for wallet signature...');

            const receipt = await sim.sendTransaction({
                signer: null,
                mldsaSigner: null,
                linkMLDSAPublicKeyToAddress: true,
                refundTo: walletAddress,
                maximumAllowedSatToSpend: 150_000n,
                network: networks.opnetTestnet,
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
            setStatusMessage('Notifying coordinator...');

            // Notify coordinator with deterministic claimTokenHint (required, from mnemonic)
            const refundAddr = bobXmrRefund.trim();
            const takeResult = await notifySwapTaken(
                swapId.toString(), resultTxId, bobKeys.claimTokenHex,
                refundAddr.length > 0 ? refundAddr : undefined,
            );
            const claimToken = takeResult.claimToken ?? bobKeys.claimTokenHex;

            // Set session context — clear mnemonic from memory after keys are derived
            setSession({
                swapId: swapId.toString(),
                role: 'bob',
                mnemonic: '',
                aliceKeys: null,
                bobKeys,
            });
            setMnemonic(null);

            // Navigate to SwapStatus immediately
            setStep('done');
            onTaken(swapId);

            // Submit Bob's keys with proof-of-knowledge (async, continues after navigation)
            setStatusMessage('Submitting split-key material...');
            try {
                const bobSpendKeyBytes = hexToUint8Array(bobKeys.bobSpendKey);
                const bobPubBytes = hexToUint8Array(bobKeys.bobEd25519PubKey);

                const keyProof = await signBobKeyProof(
                    bobSpendKeyBytes,
                    bobPubBytes,
                    swapId.toString(),
                );
                const proofHex = uint8ArrayToHex(keyProof);

                await submitBobKeys(swapId.toString(), {
                    bobEd25519PubKey: bobKeys.bobEd25519PubKey,
                    bobViewKey: bobKeys.bobViewKey,
                    bobKeyProof: proofHex,
                    bobSpendKey: bobKeys.bobSpendKey,
                    bobSecp256k1Pub: bobKeys.bobSecp256k1Pub,
                    bobDleqProof: bobKeys.bobDleqProof,
                }, claimToken);
            } catch (keyErr) {
                console.warn('Failed to submit Bob keys — will retry from status page:', keyErr);
            }
        } catch (err) {
            setStep('error');
            setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
        }
    }, [mnemonic, senderAddress, walletAddress, swapId, setSession, onTaken]);

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

    // Show mnemonic display
    if (step === 'mnemonic' && mnemonic) {
        return (
            <div style={{ maxWidth: '520px' }}>
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => { setStep('idle'); setMnemonic(null); }}
                    style={{ marginBottom: '20px' }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="19" y1="12" x2="5" y2="12" />
                        <polyline points="12 19 5 12 12 5" />
                    </svg>
                    Back
                </button>
                <div style={{ marginBottom: '20px' }}>
                    <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '4px' }}>
                        Take Swap
                    </h2>
                    <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                        Step 2: Save your recovery words before the take transaction is sent.
                    </p>
                </div>
                <MnemonicDisplay mnemonic={mnemonic} onConfirm={() => void handleMnemonicConfirmed()} />
            </div>
        );
    }

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
                                'XMR Amount',
                                <span style={{ fontWeight: 600 }}>
                                    {formatXmrAmount(swap.xmrAmount)} XMR
                                </span>,
                            )}
                            {detailRow(
                                'Fee (0.87%)',
                                <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
                                    +{formatXmrAmount(calculateXmrFee(swap.xmrAmount))} XMR
                                </span>,
                            )}
                            {detailRow(
                                'Total XMR to Lock',
                                <span style={{ color: 'var(--color-text-warning)', fontWeight: 700 }}>
                                    {formatXmrAmount(calculateXmrTotal(swap.xmrAmount))} XMR
                                </span>,
                            )}
                            {detailRow(
                                'Status',
                                <span style={{ textTransform: 'capitalize' }}>
                                    {SWAP_STATUS_LABELS[swap.status.toString()] ?? 'Unknown'}
                                </span>,
                            )}
                            {detailRow(
                                'Expires In (blocks)',
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
                                    background: 'rgba(232, 115, 42, 0.06)',
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
                                        background: 'var(--color-orange)',
                                        animation: 'pulse 2s ease-in-out infinite',
                                    }}
                                />
                                {statusMessage || 'Processing...'}
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

                        {step !== 'done' && step !== 'mnemonic' && swap.status === 0n && !isExpired && (
                            <>
                                <div
                                    style={{
                                        padding: '12px 14px',
                                        background: 'rgba(255, 215, 64, 0.06)',
                                        border: '1px solid rgba(255, 215, 64, 0.15)',
                                        borderRadius: 'var(--radius-md)',
                                        marginTop: '16px',
                                        fontSize: '0.78rem',
                                        color: 'var(--color-text-secondary)',
                                        lineHeight: 1.55,
                                    }}
                                >
                                    <strong style={{ color: 'var(--color-text-warning)' }}>Before you take this swap:</strong>{' '}
                                    You will be given <strong>12 recovery words</strong> — have pen and paper ready.
                                    After taking the swap, you will need to <strong>deposit XMR</strong> to a shared escrow address.
                                    The swap requires ~20 minutes for Monero confirmations.
                                </div>
                                <div style={{ marginTop: '12px' }}>
                                    <label
                                        style={{
                                            display: 'block',
                                            fontSize: '0.78rem',
                                            color: 'var(--color-text-secondary)',
                                            marginBottom: '4px',
                                        }}
                                    >
                                        XMR Refund Address (optional)
                                    </label>
                                    <input
                                        type="text"
                                        className="input"
                                        placeholder="4... or 8..."
                                        value={bobXmrRefund}
                                        onChange={e => setBobXmrRefund(e.target.value)}
                                        style={{
                                            width: '100%',
                                            fontFamily: 'var(--font-mono)',
                                            fontSize: '0.78rem',
                                        }}
                                        disabled={step === 'taking'}
                                    />
                                    <p style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: '2px' }}>
                                        If the swap expires, XMR will be refunded here. Leave blank to use the operator address.
                                    </p>
                                </div>
                                <button
                                    className="btn btn-primary btn-lg"
                                    style={{ width: '100%', marginTop: '12px' }}
                                    disabled={!isConnected || step === 'taking'}
                                    onClick={handleStartTake}
                                >
                                    {step === 'taking' ? (statusMessage || 'Taking Swap...') : 'Take Swap'}
                                </button>
                            </>
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
