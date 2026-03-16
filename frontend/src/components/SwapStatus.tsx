/**
 * SwapStatus component — state machine visualization for a swap's lifecycle.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { networks } from '@btc-vision/bitcoin';
import { getSwapVaultContract, formatTokenAmount, formatXmrAmount } from '../services/opnet';
import { calculateXmrFee, calculateXmrTotal } from '../types/swap';
import { getCoordinatorSwapStatus, submitSwapSecret, submitBobKeys, fetchMySecret } from '../services/coordinator';
import { getLocalSwapSecret, getClaimToken, clearLocalSwapSecret, clearClaimToken, secretHexToBigint, getBobKeys, markBobKeysSubmitted, clearBobKeys, saveLocalSwapSecret } from '../utils/hashlock';
import { useSwap, useBlockNumber } from '../hooks/useSwaps';
import { useCoordinatorWs } from '../hooks/useCoordinatorWs';
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
    { key: 'xmr_locking', label: 'XMR Locking', description: 'Awaiting XMR deposit' },
    { key: 'xmr_locked', label: 'XMR Locked', description: 'XMR in escrow' },
    { key: 'claimed', label: 'Claimed', description: 'MOTO claimed' },
    { key: 'complete', label: 'Complete', description: 'Swap finalized' },
];

function getActiveDescription(step: StepKey, isAlice: boolean, xmrConfirmations?: number, isDepositor?: boolean): string {
    const hasConfs = xmrConfirmations !== undefined && xmrConfirmations > 0;
    const descriptions: Record<StepKey, string> = {
        created: isAlice
            ? 'Your MOTO is locked on-chain. Waiting for a buyer to accept this swap.'
            : 'Your take transaction is confirming on-chain (3–5 min).',
        taken: isAlice
            ? 'A buyer has accepted your swap. The coordinator is setting up the XMR escrow.'
            : 'Swap accepted. The coordinator is generating the XMR escrow address.',
        xmr_locking: hasConfs
            ? (isAlice
                ? 'XMR deposit received. Waiting for 10 confirmations (~20 min). No action needed.'
                : 'XMR deposit received. Waiting for 10 confirmations (~20 min). You\'ll be able to claim MOTO once confirmed.')
            : (isAlice
                ? 'The coordinator is depositing XMR to the escrow address. This is automatic.'
                : 'Send the exact XMR amount shown below to the escrow address. 10 confirmations needed (~20 min).'),
        xmr_locked: isAlice
            ? 'XMR is safely locked in escrow. Waiting for the buyer to claim MOTO.'
            : 'XMR is locked. You can now claim your MOTO.',
        claimed: isAlice
            ? 'The buyer claimed your MOTO. XMR is being automatically sent to your wallet...'
            : 'You successfully claimed MOTO!',
        complete: (isAlice || isDepositor)
            ? 'Swap complete. Your XMR is being sent to your Monero wallet.'
            : 'Swap complete. MOTO has been transferred to your wallet.',
    };
    return descriptions[step];
}

function stepIndex(step: StepKey): number {
    return STEPS.findIndex((s) => s.key === step);
}

/**
 * Renders the swap state machine progress and relevant actions.
 */
export function SwapStatus({ swapId, onBack }: SwapStatusProps): React.ReactElement {
    const { publicKey, address: senderAddress, walletAddress } = useWalletConnect();
    const isConnected = publicKey !== null;
    const { swap, isLoading, error: loadError } = useSwap(swapId);
    const currentBlock = useBlockNumber();

    const [coordinatorStatus, setCoordinatorStatus] = useState<CoordinatorStatus | null>(null);
    const [claimStep, setClaimStep] = useState<'idle' | 'claiming' | 'done' | 'error'>('idle');
    const [refundStep, setRefundStep] = useState<'idle' | 'refunding' | 'done' | 'error'>('idle');
    const [cancelStep, setCancelStep] = useState<'idle' | 'cancelling' | 'done' | 'error'>('idle');
    const [actionTxId, setActionTxId] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    const [recoveredSecret, setRecoveredSecret] = useState<{ secret: string; aliceViewKey: string | null; aliceXmrPayout: string | null } | null>(null);
    const recoveryAttempted = useRef(false);

    const localSecret = getLocalSwapSecret(swapId.toString());
    // Stable reference for useEffect deps — only changes if the actual secret string changes
    const localSecretHex = localSecret?.secret ?? recoveredSecret?.secret ?? null;
    const localViewKey = localSecret?.aliceViewKey ?? recoveredSecret?.aliceViewKey ?? undefined;
    const localXmrPayout = localSecret?.aliceXmrPayout ?? recoveredSecret?.aliceXmrPayout ?? undefined;

    // If no local secret, try recovering from coordinator (authenticated by depositor address).
    // The coordinator is the authoritative store — localStorage is just a cache.
    const swapDepositor = swap?.depositor;
    const swapHashLock = swap?.hashLock;
    useEffect(() => {
        if (localSecret || recoveryAttempted.current || !swapDepositor || !senderAddress) return;
        // Only attempt if connected wallet matches the depositor
        if (swapDepositor.toLowerCase() !== senderAddress.toString().toLowerCase()) return;
        recoveryAttempted.current = true;

        void fetchMySecret(swapId.toString(), senderAddress.toString()).then((result) => {
            if (result) {
                console.log('[SwapStatus] Recovered secret from coordinator (authenticated)');
                const hashLockHex = result.hashLock ?? swapHashLock?.toString(16).padStart(64, '0') ?? '';
                setRecoveredSecret(result);
                // Re-save to localStorage as cache
                if (hashLockHex) {
                    saveLocalSwapSecret(swapId.toString(), result.secret, hashLockHex, result.aliceViewKey ?? undefined, result.aliceXmrPayout ?? undefined);
                }
            }
        });
    }, [swapDepositor, swapHashLock, swapId, localSecret, senderAddress]);

    // Retrieve claim_token for authenticated WebSocket subscription
    const claimToken = getClaimToken(swapId.toString());

    // WebSocket connection for real-time preimage delivery (authenticated)
    // Pass hashLock so received preimages are verified before acceptance
    const { preimage: wsPreimage, queuePosition } = useCoordinatorWs(swapId.toString(), claimToken, localSecret?.hashLock ?? null);

    // Combined preimage: prefer local secret, fall back to WebSocket preimage
    const claimablePreimage = localSecret?.secret ?? wsPreimage;

    // Persistently retry submitting secret to coordinator until it succeeds.
    const secretSubmitted = useRef(false);
    useEffect(() => {
        if (!localSecretHex) {

            return;
        }
        if (secretSubmitted.current) {

            return;
        }



        let cancelled = false;
        let attemptCount = 0;

        const trySubmit = async (): Promise<boolean> => {
            attemptCount++;
            const result = await submitSwapSecret(swapId.toString(), localSecretHex, localViewKey, localXmrPayout);
            return result.ok;
        };

        const interval = setInterval(() => {
            if (cancelled || secretSubmitted.current) {
                clearInterval(interval);
                return;
            }
            void trySubmit().then((ok) => {
                if (ok) {
                    secretSubmitted.current = true;
                    clearInterval(interval);
                }
            });
        }, 10_000);

        // Try immediately
        void trySubmit().then((ok) => {
            if (ok) {
                secretSubmitted.current = true;
                clearInterval(interval);
            }
        });

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [localSecretHex, localViewKey, localXmrPayout, swapId]); // stable primitive deps

    // Persistently retry Bob key submission until it succeeds.
    const bobKeysSubmittedRef = useRef(false);
    useEffect(() => {
        if (bobKeysSubmittedRef.current) return;
        const storedBobKeys = getBobKeys(swapId.toString());
        if (!storedBobKeys || storedBobKeys.submitted) {
            bobKeysSubmittedRef.current = true;
            return;
        }

        let cancelled = false;
        const trySubmit = async (): Promise<boolean> => {
            try {
                return await submitBobKeys(swapId.toString(), {
                    bobEd25519PubKey: storedBobKeys.bobEd25519PubKey,
                    bobViewKey: storedBobKeys.bobViewKey,
                    bobKeyProof: storedBobKeys.bobKeyProof,
                    bobSpendKey: storedBobKeys.bobSpendKey,
                }, claimToken ?? undefined);
            } catch {
                return false;
            }
        };

        const interval = setInterval(() => {
            if (cancelled || bobKeysSubmittedRef.current) {
                clearInterval(interval);
                return;
            }
            void trySubmit().then((ok) => {
                if (ok) {
                    markBobKeysSubmitted(swapId.toString());
                    bobKeysSubmittedRef.current = true;
                    clearInterval(interval);
                }
            });
        }, 10_000);

        // Try immediately too
        void trySubmit().then((ok) => {
            if (ok) {
                markBobKeysSubmitted(swapId.toString());
                bobKeysSubmittedRef.current = true;
                clearInterval(interval);
            }
        });

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [swapId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Conservative cleanup: only clear localStorage cache when swap is FULLY resolved.
    // The coordinator is the authoritative store — localStorage is just a cache.
    useEffect(() => {
        if (swap === null) return;
        const sweepDone = coordinatorStatus?.sweepStatus?.startsWith('done:');
        const noXmrLocked = !coordinatorStatus?.xmrLockAddress && !coordinatorStatus?.sweepStatus;

        if (swap.status === 2n && sweepDone) {
            // CLAIMED + XMR sweep done → safe to clear
            clearClaimToken(swapId.toString());
            clearBobKeys(swapId.toString());
            clearLocalSwapSecret(swapId.toString());
        } else if (swap.status === 3n && (noXmrLocked || sweepDone)) {
            // REFUNDED + no XMR was ever locked, OR refund sweep done → safe to clear
            clearClaimToken(swapId.toString());
            clearBobKeys(swapId.toString());
            clearLocalSwapSecret(swapId.toString());
        }
        // Otherwise: keep the cache (coordinator has the authoritative copy)
    }, [swap, swapId, coordinatorStatus?.sweepStatus, coordinatorStatus?.xmrLockAddress]);

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

    // Determine user role: Alice created the swap (has secret), Bob took it (has claim token).
    const isAlice = localSecret !== null;
    const isBob = claimToken !== null && !isAlice;

    // Determine current progress step from on-chain + coordinator state.
    // Coordinator status is authoritative for TAKEN onwards since on-chain
    // confirmation lags by 1 block (3-5 min).
    const currentStep: StepKey = (() => {
        if (swap === null) return 'created';
        if (swap.status === 2n || swap.status === 3n) {
            return 'complete';
        }
        if (coordinatorStatus !== null) {
            const cs = coordinatorStatus.step;
            if (
                cs === 'taken' ||
                cs === 'xmr_locking' ||
                cs === 'xmr_locked' ||
                cs === 'claimed' ||
                cs === 'complete'
            ) {
                return cs;
            }
        }
        if (swap.status === 1n) return 'taken';
        // Bob took the swap but on-chain/coordinator hasn't confirmed yet —
        // show 'taken' instead of misleading 'created' ("waiting for counterparty")
        if (isBob) return 'taken';
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

    // Mutex guard to prevent double-submit on claim/refund/cancel
    const actionInProgressRef = useRef(false);

    const handleClaim = useCallback(async (): Promise<void> => {
        if (actionInProgressRef.current) return;
        if (!isConnected || !walletAddress || !publicKey || !senderAddress) {
            setActionError('Connect your wallet first');
            return;
        }
        if (!claimablePreimage) {
            setActionError('No secret available. Cannot claim from this device.');
            return;
        }
        if (!SWAP_VAULT_ADDRESS) {
            setActionError('Contract address not configured');
            return;
        }

        actionInProgressRef.current = true;
        setClaimStep('claiming');
        setActionError(null);

        try {
            const contract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);
            const preimage = secretHexToBigint(claimablePreimage);

            const sim = await contract.claim(swapId, preimage);
            if ('error' in sim) throw new Error(`Simulation failed: ${String(sim.error)}`);

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
                    : 'pending';

            setActionTxId(resultTxId);
            setClaimStep('done');
        } catch (err) {
            setClaimStep('error');
            setActionError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            actionInProgressRef.current = false;
        }
    }, [isConnected, walletAddress, publicKey, senderAddress, claimablePreimage, swapId]);

    const handleRefund = useCallback(async (): Promise<void> => {
        if (actionInProgressRef.current) return;
        if (!isConnected || !walletAddress || !publicKey || !senderAddress) {
            setActionError('Connect your wallet first');
            return;
        }
        if (!SWAP_VAULT_ADDRESS) {
            setActionError('Contract address not configured');
            return;
        }

        actionInProgressRef.current = true;
        setRefundStep('refunding');
        setActionError(null);

        try {
            // senderAddress from walletconnect context (already resolved)
            const contract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);

            const sim = await contract.refund(swapId);
            if ('error' in sim) throw new Error(`Simulation failed: ${String(sim.error)}`);

            const receipt = await sim.sendTransaction({
                signer: null,
                mldsaSigner: null,
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
                    : 'pending';

            setActionTxId(resultTxId);
            setRefundStep('done');
        } catch (err) {
            setRefundStep('error');
            setActionError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            actionInProgressRef.current = false;
        }
    }, [isConnected, walletAddress, publicKey, senderAddress, swapId]);

    const handleCancel = useCallback(async (): Promise<void> => {
        if (actionInProgressRef.current) return;
        if (!isConnected || !walletAddress || !publicKey || !senderAddress) {
            setActionError('Connect your wallet first');
            return;
        }
        if (!SWAP_VAULT_ADDRESS) {
            setActionError('Contract address not configured');
            return;
        }

        actionInProgressRef.current = true;
        setCancelStep('cancelling');
        setActionError(null);

        try {
            const contract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);

            const sim = await contract.cancel(swapId);
            if ('error' in sim) throw new Error(`Simulation failed: ${String(sim.error)}`);

            const receipt = await sim.sendTransaction({
                signer: null,
                mldsaSigner: null,
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
                    : 'pending';

            setActionTxId(resultTxId);
            setCancelStep('done');
        } catch (err) {
            setCancelStep('error');
            setActionError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            actionInProgressRef.current = false;
        }
    }, [isConnected, walletAddress, publicKey, senderAddress, swapId]);

    // Depositor check for role-aware messaging
    const isDepositor = swap !== null && senderAddress !== null &&
        swap.depositor.toLowerCase() === senderAddress.toString().toLowerCase();

    const xmrClaimDone =
        coordinatorStatus !== null &&
        coordinatorStatus.sweepStatus?.startsWith('done:');

    const xmrClaimPending =
        coordinatorStatus !== null &&
        coordinatorStatus.sweepStatus === 'pending';

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

            {/* Live Status Banner */}
            {currentStep !== 'complete' && (
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '14px 18px',
                        background: 'rgba(232, 115, 42, 0.08)',
                        border: '1px solid rgba(232, 115, 42, 0.25)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '16px',
                    }}
                >
                    <div
                        style={{
                            width: '10px',
                            height: '10px',
                            borderRadius: '50%',
                            background: 'var(--color-orange)',
                            flexShrink: 0,
                            animation: 'pulse 2s ease-in-out infinite',
                        }}
                    />
                    <div>
                        <p style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--color-text-accent)', marginBottom: '2px' }}>
                            {currentStep === 'created' && (isAlice ? 'Waiting for someone to take your swap' : 'Confirming take transaction')}
                            {currentStep === 'taken' && (isAlice ? 'Counterparty accepted — setting up escrow' : isBob && coordinatorStatus?.step === 'created' ? 'Take transaction confirming on-chain' : 'Swap accepted — setting up escrow')}
                            {currentStep === 'xmr_locking' && (coordinatorStatus?.xmrLockConfirmations !== undefined && coordinatorStatus.xmrLockConfirmations > 0
                                ? `XMR deposit — ${coordinatorStatus.xmrLockConfirmations}/10 confirmations`
                                : (isAlice ? 'Awaiting XMR deposit' : 'Send XMR to the escrow address below'))}
                            {currentStep === 'xmr_locked' && ((isAlice || isDepositor) ? 'XMR locked — waiting for buyer' : 'XMR locked — claim your MOTO')}
                            {currentStep === 'claimed' && ((isAlice || isDepositor)
                                ? (xmrClaimDone ? 'XMR sent to your wallet' : xmrClaimPending ? 'Sending XMR...' : 'Claim your XMR')
                                : 'Swap complete')}
                        </p>
                        <p style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
                            {currentStep === 'created' && (isAlice
                                ? 'Your MOTO is locked on-chain. Waiting for someone to take your swap. OPNet blocks take 3–5 minutes.'
                                : 'Your take transaction is confirming on-chain. OPNet blocks take 3–5 minutes — this page updates automatically.')}
                            {currentStep === 'taken' && (isAlice
                                ? 'Someone accepted your swap! The coordinator is setting up the XMR escrow address. This is automatic.'
                                : isBob && coordinatorStatus?.step === 'created'
                                    ? 'Your take transaction is confirming on-chain. OPNet blocks take 3–5 minutes. Once confirmed, XMR escrow setup begins automatically.'
                                    : 'You accepted this swap. The coordinator is generating the XMR escrow address — no action needed.')}
                            {currentStep === 'xmr_locking' && (
                                <>
                                    {coordinatorStatus?.xmrLockConfirmations !== undefined && coordinatorStatus.xmrLockConfirmations > 0
                                        ? (isAlice
                                            ? 'XMR deposit received. Waiting for 10 confirmations on the Monero network. No action needed.'
                                            : 'XMR deposit received. Waiting for 10 confirmations (~20 min). You can claim MOTO once confirmed.')
                                        : (isAlice
                                            ? 'The coordinator is depositing XMR to the escrow address. No action needed from you.'
                                            : coordinatorStatus?.xmrTxId && coordinatorStatus.xmrTxId !== 'pending'
                                                ? 'XMR has been sent. Waiting for first confirmation — this can take several minutes. Do not send again.'
                                                : 'Send the exact XMR amount to the escrow address shown below. Only send once — do not retry if it appears slow.')}
                                    {coordinatorStatus?.xmrLockConfirmations !== undefined && (
                                        <span
                                            style={{
                                                display: 'block',
                                                marginTop: '8px',
                                                height: '6px',
                                                borderRadius: '3px',
                                                background: 'rgba(255,255,255,0.08)',
                                                overflow: 'hidden',
                                            }}
                                        >
                                            <span
                                                style={{
                                                    display: 'block',
                                                    height: '100%',
                                                    width: `${Math.min(100, (coordinatorStatus.xmrLockConfirmations / 10) * 100)}%`,
                                                    background: 'linear-gradient(90deg, var(--color-orange), var(--color-orange-light))',
                                                    borderRadius: '3px',
                                                    transition: 'width 0.5s ease',
                                                }}
                                            />
                                        </span>
                                    )}
                                </>
                            )}
                            {currentStep === 'xmr_locked' && ((isAlice || isDepositor)
                                ? 'XMR is safely locked with 10+ confirmations. Waiting for the buyer to claim MOTO — no action needed.'
                                : 'XMR is safely locked with 10+ confirmations. Click "Claim MOTO" to receive your tokens.')}
                            {currentStep === 'claimed' && ((isAlice || isDepositor)
                                ? (xmrClaimDone
                                    ? 'XMR has been sent to your Monero wallet. It should arrive within a few minutes.'
                                    : xmrClaimPending
                                        ? 'XMR is being sent to your Monero wallet. This may take a minute...'
                                        : 'The buyer claimed your MOTO. XMR is being automatically sent to your wallet...')
                                : 'MOTO has been transferred to your wallet. The swap is complete.')}
                        </p>
                    </div>
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
                                                ? 'var(--color-orange)'
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
                                                ? 'var(--color-orange)'
                                                : isActive
                                                  ? 'var(--color-orange)'
                                                  : 'var(--color-border-subtle)'
                                        }`,
                                        background: isDone
                                            ? 'var(--color-orange)'
                                            : isActive
                                              ? 'rgba(232, 115, 42, 0.12)'
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
                                <div style={{ paddingTop: '4px', flex: 1 }}>
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
                                                    background: 'rgba(232, 115, 42, 0.1)',
                                                    padding: '1px 6px',
                                                    borderRadius: '999px',
                                                    border: '1px solid rgba(232, 115, 42, 0.2)',
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
                                            color: isActive
                                                ? 'var(--color-text-accent)'
                                                : isPending
                                                  ? 'var(--color-text-muted)'
                                                  : 'var(--color-text-secondary)',
                                        }}
                                    >
                                        {isActive ? getActiveDescription(step.key, isAlice, coordinatorStatus?.xmrLockConfirmations, isDepositor) : step.description}
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
                            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Fee (0.87%)</p>
                            <p className="tabular-nums" style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>
                                +{formatXmrAmount(calculateXmrFee(swap.xmrAmount))} XMR
                            </p>
                        </div>
                        <div>
                            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total XMR (Taker Locks)</p>
                            <p className="tabular-nums" style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--color-text-warning)' }}>
                                {formatXmrAmount(calculateXmrTotal(swap.xmrAmount))}
                            </p>
                        </div>
                        <div>
                            <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Expires In</p>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <p style={{ fontWeight: 600, color: 'rgba(200, 180, 255, 0.9)' }}>
                            Coordinator Update
                        </p>
                        {coordinatorStatus.trustlessMode && (
                            <span
                                style={{
                                    fontSize: '0.65rem',
                                    fontWeight: 700,
                                    color: 'var(--color-text-success)',
                                    background: 'rgba(0, 230, 118, 0.1)',
                                    padding: '2px 8px',
                                    borderRadius: '999px',
                                    border: '1px solid rgba(0, 230, 118, 0.25)',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.06em',
                                }}
                            >
                                Split-Key
                            </span>
                        )}
                    </div>
                    <p style={{ color: 'var(--color-text-secondary)' }}>
                        {coordinatorStatus.message}
                    </p>
                    {coordinatorStatus.xmrTxId !== undefined && coordinatorStatus.xmrTxId !== 'pending' && (
                        <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '6px' }}>
                            XMR TX: {coordinatorStatus.xmrTxId.slice(0, 20)}...
                        </p>
                    )}
                    {coordinatorStatus.trustlessMode && coordinatorStatus.aliceEd25519Pub && coordinatorStatus.bobEd25519Pub && (
                        <div style={{ marginTop: '8px', fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>
                            <p>Alice key: {coordinatorStatus.aliceEd25519Pub.slice(0, 16)}...{coordinatorStatus.aliceEd25519Pub.slice(-8)}</p>
                            <p>Bob key: {coordinatorStatus.bobEd25519Pub.slice(0, 16)}...{coordinatorStatus.bobEd25519Pub.slice(-8)}</p>
                        </div>
                    )}
                    {coordinatorStatus.trustlessMode && !coordinatorStatus.bobEd25519Pub && coordinatorStatus.step === 'taken' && (
                        <p style={{ marginTop: '6px', fontSize: '0.78rem', color: 'var(--color-text-warning)' }}>
                            Waiting for taker&apos;s key material...
                        </p>
                    )}
                </div>
            )}

            {/* XMR Lock Address */}
            {coordinatorStatus !== null &&
                coordinatorStatus.xmrLockAddress !== undefined &&
                /^[48][1-9A-HJ-NP-Za-km-z]{94}$/.test(coordinatorStatus.xmrLockAddress) &&
                (coordinatorStatus.step === 'xmr_locking' || coordinatorStatus.step === 'xmr_locked') && (
                <div
                    style={{
                        padding: '16px',
                        background: 'rgba(255, 152, 0, 0.06)',
                        border: '1px solid rgba(255, 152, 0, 0.25)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '16px',
                    }}
                >
                    <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                        XMR Lock Address
                    </p>
                    <div
                        style={{
                            padding: '10px 12px',
                            background: 'rgba(0,0,0,0.2)',
                            borderRadius: 'var(--radius-sm)',
                            fontFamily: 'var(--font-mono)',
                            fontSize: '0.72rem',
                            wordBreak: 'break-all',
                            color: 'var(--color-text-primary)',
                            cursor: 'pointer',
                            userSelect: 'all',
                        }}
                        title="Click to select"
                    >
                        {coordinatorStatus.xmrLockAddress}
                    </div>
                    {swap !== null && (
                        <p style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: '8px' }}>
                            {isAlice
                                ? <>Buyer must deposit <strong>{formatXmrAmount(calculateXmrTotal(swap.xmrAmount))}</strong> XMR to this address</>
                                : <>Send exactly <strong>{formatXmrAmount(calculateXmrTotal(swap.xmrAmount))}</strong> XMR to this address</>}
                        </p>
                    )}
                    {coordinatorStatus.xmrLockConfirmations !== undefined && (
                        <p
                            style={{
                                fontSize: '0.82rem',
                                fontWeight: 600,
                                color: coordinatorStatus.xmrLockConfirmations >= 10
                                    ? 'var(--color-text-success)'
                                    : 'var(--color-text-warning)',
                                marginTop: '6px',
                            }}
                        >
                            Confirmations: {coordinatorStatus.xmrLockConfirmations} / 10
                        </p>
                    )}
                </div>
            )}

            {/* Refund Warning (approaching expiry) */}
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
                    timeout.{' '}
                    {(isAlice || isDepositor)
                        ? 'If the swap does not complete, you can request a refund after the timeout expires.'
                        : 'If the swap does not complete before timeout, the depositor can reclaim their MOTO.'}
                </div>
            )}

            {/* Expired — refund available */}
            {canRefund && (
                <div
                    style={{
                        padding: '14px 16px',
                        background: 'rgba(255, 82, 82, 0.08)',
                        border: '1px solid rgba(255, 82, 82, 0.25)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '16px',
                        fontSize: '0.875rem',
                        color: 'var(--color-text-error)',
                    }}
                >
                    <strong>Swap Expired.</strong>{' '}
                    {(isAlice || isDepositor)
                        ? 'The timelock has passed. You can now reclaim your MOTO using the refund button below.'
                        : 'The timelock has passed. The depositor can now reclaim their MOTO.'}
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

            {(claimStep === 'done' || refundStep === 'done' || cancelStep === 'done') && actionTxId !== null && (
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
                        {claimStep === 'done' ? 'Claim Submitted' : cancelStep === 'done' ? 'Cancel Submitted' : 'Refund Submitted'}
                    </p>
                    <ExplorerLinks txId={actionTxId} address={walletAddress ?? undefined} />
                </div>
            )}

            {/* Action area — shows state-appropriate message or claim button */}
            {claimStep === 'claiming' ? (
                <button className="btn btn-primary btn-lg" style={{ width: '100%', marginBottom: '12px' }} disabled>
                    Claiming...
                </button>
            ) : claimStep === 'done' ? (
                <div
                    style={{
                        padding: '14px 18px',
                        background: 'rgba(74, 222, 128, 0.06)',
                        border: '1px solid rgba(74, 222, 128, 0.2)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                    }}
                >
                    <div
                        style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: '#4ade80',
                            flexShrink: 0,
                            animation: 'pulse 2s ease-in-out infinite',
                        }}
                    />
                    <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                        Claim transaction broadcast. Waiting for on-chain confirmation (1–2 blocks, ~3–10 min). The page will update automatically.
                    </p>
                </div>
            ) : swap !== null && swap.status < 2n && currentStep !== 'complete' && (
                (() => {
                    // Bob can claim once XMR is locked
                    const canClaim =
                        claimablePreimage !== null &&
                        !localSecret &&
                        coordinatorStatus !== null &&
                        (coordinatorStatus.step === 'xmr_locked' || coordinatorStatus.step === 'claimed');

                    if (canClaim) {
                        return (
                            <button
                                className="btn btn-primary btn-lg"
                                style={{ width: '100%', marginBottom: '12px' }}
                                disabled={!isConnected}
                                onClick={() => void handleClaim()}
                            >
                                Claim MOTO (reveal secret)
                            </button>
                        );
                    }

                    // Otherwise show a waiting message appropriate to the current step and role
                    const waitingMessages: Record<string, string> = {
                        created: isAlice
                            ? 'Waiting for someone to take your swap. Your MOTO is safely locked on-chain.'
                            : 'Connecting with seller. Your take transaction is confirming on-chain — OPNet blocks take 3–5 minutes.',
                        taken: isAlice
                            ? 'A counterparty accepted your swap! The coordinator is setting up the XMR escrow. This is automatic — no action needed.'
                            : 'You accepted this swap. Waiting for on-chain confirmation and XMR escrow setup. OPNet blocks take 3–5 minutes.',
                        xmr_locking: (coordinatorStatus?.xmrLockConfirmations !== undefined && coordinatorStatus.xmrLockConfirmations > 0)
                            ? (isAlice
                                ? 'XMR deposit received. Waiting for 10 confirmations. No action needed.'
                                : 'XMR deposit received! Waiting for 10 confirmations (~20 min).')
                            : (isAlice
                                ? 'Waiting for the buyer to deposit XMR to the escrow address. No action needed from you.'
                                : 'Send the exact XMR amount to the escrow address above. 10 Monero confirmations needed (~20 min).'),
                        xmr_locked: (isAlice || isDepositor)
                            ? 'XMR is locked in escrow. Waiting for the counterparty to claim MOTO — no action needed from you.'
                            : 'XMR is locked! You can claim your MOTO once the secret is delivered.',
                        claimed: (isAlice || isDepositor)
                            ? 'MOTO has been claimed. XMR is being automatically sent to your wallet...'
                            : 'You claimed MOTO! The swap is being finalized.',
                    };

                    const msg = waitingMessages[currentStep];
                    if (!msg) return null;

                    return (
                        <div
                            style={{
                                padding: '14px 18px',
                                background: 'rgba(232, 115, 42, 0.06)',
                                border: '1px solid var(--color-border-default)',
                                borderRadius: 'var(--radius-md)',
                                marginBottom: '12px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                            }}
                        >
                            <div
                                style={{
                                    width: '8px',
                                    height: '8px',
                                    borderRadius: '50%',
                                    background: 'var(--color-orange)',
                                    flexShrink: 0,
                                    animation: 'pulse 2s ease-in-out infinite',
                                }}
                            />
                            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                                {msg}
                            </p>
                        </div>
                    );
                })()
            )}

            {/* Auto XMR Sweep Status */}
            {(isAlice || isDepositor) && (xmrClaimDone || xmrClaimPending || coordinatorStatus?.sweepStatus?.startsWith('failed:') || queuePosition !== null) && (
                <div
                    style={{
                        padding: '14px 18px',
                        background: 'rgba(74, 222, 128, 0.06)',
                        border: '1px solid rgba(74, 222, 128, 0.2)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                    }}
                >
                    <div
                        style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: xmrClaimDone ? '#4ade80' : coordinatorStatus?.sweepStatus?.startsWith('failed:') ? 'var(--color-text-error)' : 'var(--color-orange)',
                            flexShrink: 0,
                            animation: xmrClaimDone ? 'none' : 'pulse 2s ease-in-out infinite',
                        }}
                    />
                    <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                        {xmrClaimDone
                            ? 'XMR has been sent to your Monero wallet. It may take a few minutes to appear.'
                            : coordinatorStatus?.sweepStatus?.startsWith('failed:')
                                ? 'XMR sweep failed. The coordinator will automatically retry every 5 minutes.'
                                : queuePosition !== null && queuePosition.position === 1
                                    ? 'Your XMR sweep is processing now...'
                                    : queuePosition !== null && queuePosition.position > 1
                                        ? `Your XMR is being processed — Position #${queuePosition.position} of ${queuePosition.total} in queue`
                                        : 'XMR is being automatically sent to your Monero wallet...'}
                    </p>
                </div>
            )}

            {/* Cancel action — OPEN swaps only, depositor only, no timelock needed */}
            {swap !== null && swap.status === 0n && isDepositor && cancelStep === 'idle' && !isExpired && (
                <button
                    className="btn btn-ghost btn-lg"
                    style={{ width: '100%', marginBottom: '12px' }}
                    disabled={!isConnected}
                    onClick={() => void handleCancel()}
                >
                    Cancel Swap
                </button>
            )}

            {cancelStep === 'cancelling' && (
                <button className="btn btn-ghost btn-lg" style={{ width: '100%', marginBottom: '12px' }} disabled>
                    Cancelling...
                </button>
            )}

            {cancelStep === 'done' && actionTxId !== null && (
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
                        Swap Cancelled — MOTO returned
                    </p>
                    <ExplorerLinks txId={actionTxId} address={walletAddress ?? undefined} />
                </div>
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
                        background: 'rgba(232, 115, 42, 0.06)',
                        border: '1px solid var(--color-border-default)',
                        borderRadius: 'var(--radius-md)',
                        textAlign: 'center',
                    }}
                >
                    <p style={{ fontWeight: 700, color: 'var(--color-text-accent)', fontSize: '1rem' }}>
                        {swap.status === 3n
                            ? 'Swap Refunded'
                            : (isAlice || isDepositor)
                                ? (xmrClaimDone
                                    ? 'Swap Complete'
                                    : xmrClaimPending
                                        ? 'Sending XMR...'
                                        : coordinatorStatus?.sweepStatus?.startsWith('failed:')
                                            ? 'XMR Sweep Retrying...'
                                            : 'Swap Complete')
                                : 'Swap Complete'}
                    </p>
                    <p style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
                        {swap.status === 3n
                            ? 'MOTO has been returned to the seller.'
                            : (isAlice || isDepositor)
                                ? (xmrClaimDone
                                    ? 'Your XMR has been sent. It may take a few minutes to appear in your wallet.'
                                    : xmrClaimPending
                                        ? 'XMR is being automatically sent to your Monero wallet...'
                                        : coordinatorStatus?.sweepStatus?.startsWith('failed:')
                                            ? 'XMR sweep failed — the coordinator will automatically retry.'
                                            : 'The buyer claimed your MOTO. XMR is being sent to your wallet.')
                                : 'MOTO has been transferred to your wallet.'}
                    </p>
                </div>
            )}
        </div>
    );
}
