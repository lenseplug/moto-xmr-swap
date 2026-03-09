/**
 * SwapStatus component — state machine visualization for a swap's lifecycle.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { Address } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { getSwapVaultContract, formatTokenAmount, formatXmrAmount } from '../services/opnet';
import { getCoordinatorSwapStatus } from '../services/coordinator';
import { getLocalSwapSecret, secretHexToBigint } from '../utils/hashlock';
import { useSwap, useBlockNumber } from '../hooks/useSwaps';
import type { CoordinatorStatus } from '../types/swap';
import { ExplorerLinks } from './ExplorerLinks';
import { SkeletonBlock } from './SkeletonRow';

const SWAP_VAULT_ADDRESS = import.meta.env.VITE_SWAP_VAULT_ADDRESS;
const POLL_COORDINATOR_MS = 15_000;
const REFUND_WARN_BLOCKS = 20n;

interface SwapStatusProps {
    readonly swapId: bigint;
    readonly onBack: () => void;
}

type StepKey = 'created' | 'taken' | 'xmr_locking' | 'xmr_locked' | 'claimed' | 'complete';

const STEPS: Array<{ key: StepKey; label: string; description: string }> = [
    { key: 'created', label: 'Created', description: 'MOTO locked in vault' },
    { key: 'taken', label: 'Taken', description: 'Counterparty accepted' },
    { key: 'xmr_locking', label: 'XMR Locking', description: 'Coordinator locking XMR' },
    { key: 'xmr_locked', label: 'XMR Locked', description: 'XMR in escrow' },
    { key: 'claimed', label: 'Claimed', description: 'MOTO claimed by counterparty' },
    { key: 'complete', label: 'Complete', description: 'Swap finalized' },
];

function stepIndex(step: StepKey): number {
    return STEPS.findIndex((s) => s.key === step);
}

/**
 * Renders the swap state machine progress and relevant actions.
 */
export function SwapStatus({ swapId, onBack }: SwapStatusProps): React.ReactElement {
    const { publicKey, hashedMLDSAKey, walletAddress } = useWalletConnect();
    const isConnected = publicKey !== null;
    const { swap, isLoading, error: loadError } = useSwap(swapId);
    const currentBlock = useBlockNumber();

    const [coordinatorStatus, setCoordinatorStatus] = useState<CoordinatorStatus | null>(null);
    const [claimStep, setClaimStep] = useState<'idle' | 'claiming' | 'done' | 'error'>('idle');
    const [refundStep, setRefundStep] = useState<'idle' | 'refunding' | 'done' | 'error'>('idle');
    const [actionTxId, setActionTxId] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    const localSecret = getLocalSwapSecret(swapId.toString());

    // Poll coordinator
    useEffect(() => {
        let mounted = true;

        const poll = async (): Promise<void> => {
            const status = await getCoordinatorSwapStatus(swapId.toString());
            if (mounted) setCoordinatorStatus(status);
        };

        void poll();
        const interval = setInterval(() => void poll(), POLL_COORDINATOR_MS);
        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, [swapId]);

    // Determine current progress step from on-chain state
    const currentStep: StepKey = (() => {
        if (swap === null) return 'created';
        if (swap.status === 2n || swap.status === 3n) {
            return 'complete';
        }
        if (coordinatorStatus !== null) {
            const cs = coordinatorStatus.step;
            if (
                cs === 'xmr_locking' ||
                cs === 'xmr_locked' ||
                cs === 'claimed' ||
                cs === 'complete'
            ) {
                return cs;
            }
        }
        if (swap.status === 1n) return 'taken';
        return 'created';
    })();

    const currentStepIdx = stepIndex(currentStep);

    const blocksLeft =
        swap !== null && currentBlock !== null && swap.refundBlock > currentBlock
            ? swap.refundBlock - currentBlock
            : null;

    const isExpired = swap !== null && currentBlock !== null && swap.refundBlock <= currentBlock;
    const showRefundWarn = blocksLeft !== null && blocksLeft <= REFUND_WARN_BLOCKS && !isExpired;
    const canRefund = swap !== null && (swap.status === 0n || swap.status === 1n) && isExpired;

    const handleClaim = useCallback(async (): Promise<void> => {
        if (!isConnected || !walletAddress || !publicKey || !hashedMLDSAKey) {
            setActionError('Connect your wallet first');
            return;
        }
        if (localSecret === null) {
            setActionError('No local secret found. Cannot claim from this device.');
            return;
        }
        if (!SWAP_VAULT_ADDRESS) {
            setActionError('Contract address not configured');
            return;
        }

        setClaimStep('claiming');
        setActionError(null);

        try {
            const senderAddress = Address.fromString(hashedMLDSAKey, publicKey);
            const contract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);
            const preimage = secretHexToBigint(localSecret.secret);

            const sim = await contract.claim(swapId, preimage);
            if ('error' in sim) throw new Error(`Simulation failed: ${String(sim.error)}`);

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
                    : 'pending';

            setActionTxId(resultTxId);
            setClaimStep('done');
        } catch (err) {
            setClaimStep('error');
            setActionError(err instanceof Error ? err.message : 'Unknown error');
        }
    }, [isConnected, walletAddress, publicKey, hashedMLDSAKey, localSecret, swapId]);

    const handleRefund = useCallback(async (): Promise<void> => {
        if (!isConnected || !walletAddress || !publicKey || !hashedMLDSAKey) {
            setActionError('Connect your wallet first');
            return;
        }
        if (!SWAP_VAULT_ADDRESS) {
            setActionError('Contract address not configured');
            return;
        }

        setRefundStep('refunding');
        setActionError(null);

        try {
            const senderAddress = Address.fromString(hashedMLDSAKey, publicKey);
            const contract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);

            const sim = await contract.refund(swapId);
            if ('error' in sim) throw new Error(`Simulation failed: ${String(sim.error)}`);

            const receipt = await sim.sendTransaction({
                signer: null,
                mldsaSigner: null,
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
                    : 'pending';

            setActionTxId(resultTxId);
            setRefundStep('done');
        } catch (err) {
            setRefundStep('error');
            setActionError(err instanceof Error ? err.message : 'Unknown error');
        }
    }, [isConnected, walletAddress, publicKey, hashedMLDSAKey, swapId]);

    return (
        <div style={{ maxWidth: '560px' }}>
            <button
                className="btn btn-ghost btn-sm"
                onClick={onBack}
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
                    Swap Status
                </h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                    ID:{' '}
                    <span className="font-mono" style={{ color: 'var(--color-text-accent)' }}>
                        {swapId.toString()}
                    </span>
                </p>
            </div>

            {loadError !== null && (
                <div
                    style={{
                        padding: '12px 14px',
                        background: 'rgba(255, 82, 82, 0.08)',
                        border: '1px solid rgba(255, 82, 82, 0.25)',
                        borderRadius: 'var(--radius-md)',
                        color: 'var(--color-text-error)',
                        marginBottom: '16px',
                        fontSize: '0.875rem',
                    }}
                >
                    {loadError}
                </div>
            )}

            {/* Progress Steps */}
            <div className="glass-card" style={{ padding: '24px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                    {STEPS.map((step, idx) => {
                        const isActive = idx === currentStepIdx;
                        const isDone = idx < currentStepIdx;
                        const isPending = idx > currentStepIdx;

                        return (
                            <div
                                key={step.key}
                                style={{
                                    display: 'flex',
                                    gap: '16px',
                                    alignItems: 'flex-start',
                                    paddingBottom: idx < STEPS.length - 1 ? '20px' : '0',
                                    position: 'relative',
                                }}
                            >
                                {/* Line connector */}
                                {idx < STEPS.length - 1 && (
                                    <div
                                        style={{
                                            position: 'absolute',
                                            left: '15px',
                                            top: '30px',
                                            bottom: '0',
                                            width: '2px',
                                            background: isDone
                                                ? 'var(--color-cyan)'
                                                : 'var(--color-border-subtle)',
                                        }}
                                    />
                                )}

                                {/* Circle */}
                                <div
                                    style={{
                                        width: '32px',
                                        height: '32px',
                                        borderRadius: '50%',
                                        flexShrink: 0,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        border: `2px solid ${
                                            isDone
                                                ? 'var(--color-cyan)'
                                                : isActive
                                                  ? 'var(--color-cyan)'
                                                  : 'var(--color-border-subtle)'
                                        }`,
                                        background: isDone
                                            ? 'var(--color-cyan)'
                                            : isActive
                                              ? 'rgba(0, 229, 255, 0.12)'
                                              : 'transparent',
                                        zIndex: 1,
                                    }}
                                >
                                    {isDone ? (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-bg-void)" strokeWidth="3">
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                    ) : (
                                        <span
                                            style={{
                                                fontSize: '0.75rem',
                                                fontWeight: 700,
                                                color: isActive
                                                    ? 'var(--color-text-accent)'
                                                    : isPending
                                                      ? 'var(--color-text-muted)'
                                                      : 'var(--color-text-primary)',
                                                fontFamily: 'var(--font-mono)',
                                            }}
                                        >
                                            {idx + 1}
                                        </span>
                                    )}
                                </div>

                                {/* Content */}
                                <div style={{ paddingTop: '4px' }}>
                                    <p
                                        style={{
                                            fontSize: '0.9rem',
                                            fontWeight: isActive ? 700 : 500,
                                            color: isPending
                                                ? 'var(--color-text-muted)'
                                                : 'var(--color-text-primary)',
                                            marginBottom: '2px',
                                        }}
                                    >
                                        {step.label}
                                        {isActive && (
                                            <span
                                                style={{
                                                    marginLeft: '8px',
                                                    fontSize: '0.7rem',
                                                    fontWeight: 600,
                                                    color: 'var(--color-text-accent)',
                                                    background: 'rgba(0, 229, 255, 0.1)',
                                                    padding: '1px 6px',
                                                    borderRadius: '999px',
                                                    border: '1px solid rgba(0, 229, 255, 0.2)',
                                                    textTransform: 'uppercase',
                                                    letterSpacing: '0.05em',
                                                }}
                                            >
                                                Current
                                            </span>
                                        )}
                                    </p>
                                    <p
                                        style={{
                                            fontSize: '0.78rem',
                                            color: isPending
                                                ? 'var(--color-text-muted)'
                                                : 'var(--color-text-secondary)',
                                        }}
                                    >
                                        {step.description}
                                    </p>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Swap Details */}
            {isLoading ? (
                <div className="glass-card" style={{ padding: '24px' }}>
                    <SkeletonBlock height={120} />
                </div>
            ) : swap !== null ? (
                <div className="glass-card" style={{ padding: '24px', marginBottom: '16px' }}>
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: '16px',
                        }}
                    >
                        <div>
                            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>MOTO Amount</p>
                            <p className="tabular-nums" style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                                {formatTokenAmount(swap.amount)}
                            </p>
                        </div>
                        <div>
                            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>XMR Amount</p>
                            <p className="tabular-nums" style={{ fontWeight: 700, fontSize: '1.1rem' }}>
                                {formatXmrAmount(swap.xmrAmount)}
                            </p>
                        </div>
                        <div>
                            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Blocks Left</p>
                            <p
                                className="tabular-nums"
                                style={{
                                    fontWeight: 600,
                                    color: isExpired
                                        ? 'var(--color-text-error)'
                                        : showRefundWarn
                                          ? 'var(--color-text-warning)'
                                          : 'var(--color-text-primary)',
                                }}
                            >
                                {isExpired ? 'Expired' : (blocksLeft?.toString() ?? 'Loading...')}
                            </p>
                        </div>
                        <div>
                            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Refund Block</p>
                            <p className="tabular-nums font-mono" style={{ fontSize: '0.85rem' }}>
                                {swap.refundBlock.toString()}
                            </p>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Coordinator Status */}
            {coordinatorStatus !== null && (
                <div
                    style={{
                        padding: '14px 16px',
                        background: 'rgba(124, 58, 237, 0.06)',
                        border: '1px solid rgba(124, 58, 237, 0.2)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '16px',
                        fontSize: '0.875rem',
                    }}
                >
                    <p style={{ fontWeight: 600, color: 'rgba(200, 180, 255, 0.9)', marginBottom: '4px' }}>
                        Coordinator Update
                    </p>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        {coordinatorStatus.message}
                    </p>
                    {coordinatorStatus.xmrTxId !== undefined && (
                        <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '6px' }}>
                            XMR TX: {coordinatorStatus.xmrTxId.slice(0, 20)}...
                        </p>
                    )}
                </div>
            )}

            {/* Refund Warning */}
            {showRefundWarn && (
                <div
                    style={{
                        padding: '14px 16px',
                        background: 'rgba(255, 215, 64, 0.06)',
                        border: '1px solid rgba(255, 215, 64, 0.25)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '16px',
                        fontSize: '0.875rem',
                        color: 'var(--color-text-warning)',
                    }}
                >
                    <strong>Warning:</strong> Only {blocksLeft?.toString()} blocks remaining before
                    timeout. Consider requesting a refund if the swap is not progressing.
                </div>
            )}

            {/* Actions */}
            {actionError !== null && (
                <div
                    style={{
                        padding: '12px 14px',
                        background: 'rgba(255, 82, 82, 0.08)',
                        border: '1px solid rgba(255, 82, 82, 0.25)',
                        borderRadius: 'var(--radius-md)',
                        color: 'var(--color-text-error)',
                        fontSize: '0.875rem',
                        marginBottom: '12px',
                    }}
                >
                    {actionError}
                </div>
            )}

            {(claimStep === 'done' || refundStep === 'done') && actionTxId !== null && (
                <div
                    style={{
                        padding: '16px',
                        background: 'rgba(0, 230, 118, 0.06)',
                        border: '1px solid rgba(0, 230, 118, 0.2)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '12px',
                    }}
                >
                    <p style={{ fontWeight: 600, color: 'var(--color-text-success)', marginBottom: '8px' }}>
                        {claimStep === 'done' ? 'Claim Submitted' : 'Refund Submitted'}
                    </p>
                    <ExplorerLinks txId={actionTxId} address={walletAddress ?? undefined} />
                </div>
            )}

            {/* Claim action */}
            {localSecret !== null && swap !== null && swap.status === 1n && claimStep === 'idle' && (
                <button
                    className="btn btn-primary btn-lg"
                    style={{ width: '100%', marginBottom: '12px' }}
                    disabled={!isConnected || claimStep !== 'idle'}
                    onClick={() => void handleClaim()}
                >
                    Claim MOTO (reveal secret)
                </button>
            )}

            {claimStep === 'claiming' && (
                <button className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: '12px' }} disabled>
                    Claiming...
                </button>
            )}

            {/* Refund action */}
            {canRefund && refundStep === 'idle' && (
                <button
                    className="btn btn-ghost btn-lg"
                    style={{ width: '100%' }}
                    disabled={!isConnected}
                    onClick={() => void handleRefund()}
                >
                    Request Refund
                </button>
            )}

            {refundStep === 'refunding' && (
                <button className="btn btn-ghost btn-lg" style={{ width: '100%' }} disabled>
                    Refunding...
                </button>
            )}

            {swap !== null && (swap.status === 2n || swap.status === 3n) && (
                <div
                    style={{
                        padding: '16px',
                        background: 'rgba(0, 229, 255, 0.06)',
                        border: '1px solid var(--color-border-default)',
                        borderRadius: 'var(--radius-md)',
                        textAlign: 'center',
                    }}
                >
                    <p style={{ fontWeight: 700, color: 'var(--color-text-accent)', fontSize: '1rem' }}>
                        {swap.status === 2n ? 'Swap Complete' : 'Swap Refunded'}
                    </p>
                    <p style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
                        {swap.status === 2n
                            ? 'MOTO has been claimed. The atomic swap is complete.'
                            : 'MOTO has been returned to the depositor.'}
                    </p>
                </div>
            )}
        </div>
    );
}
