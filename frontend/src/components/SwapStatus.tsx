/**
 * SwapStatus component — state machine visualization for a swap's lifecycle.
 * Uses SwapSessionContext for keys (no localStorage).
 * On page refresh, shows MnemonicInput for recovery.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { networks } from '@btc-vision/bitcoin';
import { getSwapVaultContract, formatTokenAmount, formatXmrAmount } from '../services/opnet';
import { calculateXmrFee, calculateXmrTotal } from '../types/swap';
import { getCoordinatorSwapStatus, submitSwapSecret, submitBobKeys } from '../services/coordinator';
import { secretHexToBigint, uint8ArrayToHex, hexToUint8Array } from '../utils/hashlock';
import { deriveAliceKeys, deriveBobKeys } from '../utils/mnemonic';
import { signBobKeyProof } from '../utils/ed25519';
import { verifyDleqProof } from '../utils/dleq';
import { useSwapSession } from '../contexts/SwapSessionContext';
import { useSwap, useBlockNumber } from '../hooks/useSwaps';
import { useCoordinatorWs } from '../hooks/useCoordinatorWs';
import { MnemonicInput } from './MnemonicInput';
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

type StepKey = 'created' | 'take_pending' | 'taken' | 'xmr_locking' | 'xmr_locked' | 'xmr_sweeping' | 'claimed' | 'complete';

const STEPS: Array<{ key: StepKey; label: string; description: string }> = [
    { key: 'created', label: 'Created', description: 'MOTO locked in vault' },
    { key: 'take_pending', label: 'Reserving', description: 'Counterparty reserving slot' },
    { key: 'taken', label: 'Taken', description: 'Counterparty accepted' },
    { key: 'xmr_locking', label: 'XMR Locking', description: 'Awaiting XMR deposit' },
    { key: 'xmr_locked', label: 'XMR Locked', description: 'XMR in escrow' },
    { key: 'xmr_sweeping', label: 'Securing XMR', description: 'Sending XMR to seller' },
    { key: 'claimed', label: 'Claimed', description: 'MOTO claimed' },
    { key: 'complete', label: 'Complete', description: 'Swap finalized' },
];

function getActiveDescription(step: StepKey, isAlice: boolean, xmrConfirmations?: number, isDepositor?: boolean): string {
    const hasConfs = xmrConfirmations !== undefined && xmrConfirmations > 0;
    const descriptions: Record<StepKey, string> = {
        created: isAlice
            ? 'Your MOTO is locked on-chain. Waiting for a buyer to accept this swap.'
            : 'Your take transaction is confirming on-chain (3-5 min).',
        take_pending: isAlice
            ? 'A buyer is reserving this swap. Waiting for their key submission (~60s).'
            : 'Reserving swap slot. Submitting your keys to the coordinator.',
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
        xmr_sweeping: isAlice
            ? 'XMR is being sent to your Monero wallet. Once confirmed, the buyer can claim MOTO.'
            : 'XMR is being secured for the seller. You\'ll be able to claim MOTO once this completes.',
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

export function SwapStatus({ swapId, onBack }: SwapStatusProps): React.ReactElement {
    const { publicKey, address: senderAddress, walletAddress } = useWalletConnect();
    const isConnected = publicKey !== null;
    const { swap, isLoading, error: loadError } = useSwap(swapId);
    const currentBlock = useBlockNumber();
    const { session, setSession } = useSwapSession();

    const [coordinatorStatus, setCoordinatorStatus] = useState<CoordinatorStatus | null>(null);
    const [claimStep, setClaimStep] = useState<'idle' | 'claiming' | 'done' | 'error'>('idle');
    const [refundStep, setRefundStep] = useState<'idle' | 'refunding' | 'done' | 'error'>('idle');
    const [cancelStep, setCancelStep] = useState<'idle' | 'cancelling' | 'done' | 'error'>('idle');
    const [actionTxId, setActionTxId] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    // DLEQ verification state for counterparty's cross-curve key binding
    const [dleqVerified, setDleqVerified] = useState<'pending' | 'valid' | 'invalid' | 'none'>('none');
    const dleqCheckedRef = useRef<string | null>(null);

    // Keys from session context (set by CreateSwap/TakeSwap/RecoverSwap)
    const isSessionActive = session !== null && session.swapId === swapId.toString();
    const aliceKeys = isSessionActive ? session.aliceKeys : null;
    const bobKeys = isSessionActive ? session.bobKeys : null;
    const sessionRole = isSessionActive ? session.role : null;

    // Derived values
    const secretHex = aliceKeys?.secret ?? null;
    const aliceViewKey = aliceKeys?.aliceViewKey ?? undefined;
    // hashLockHex: Alice has it from session. For Bob, derive from on-chain swap data
    // so the WS hook can verify preimage integrity via SHA-256 check.
    const swapHashLockHex = swap ? swap.hashLock.toString(16).padStart(64, '0') : null;
    const hashLockHex = aliceKeys?.hashLockHex ?? swapHashLockHex;
    const claimToken = bobKeys?.claimTokenHex ?? null;

    const isAlice = sessionRole === 'alice';
    const isBob = sessionRole === 'bob';

    // WebSocket for real-time preimage delivery
    const { preimage: wsPreimage, queuePosition } = useCoordinatorWs(swapId.toString(), claimToken, hashLockHex);

    // Combined preimage: prefer session secret, fall back to WebSocket preimage
    const claimablePreimage = secretHex ?? wsPreimage;

    // Retry submitting Alice's secret to coordinator (max 30 attempts, exponential backoff)
    const aliceSecp256k1Pub = aliceKeys?.aliceSecp256k1Pub ?? undefined;
    const aliceDleqProof = aliceKeys?.aliceDleqProof ?? undefined;
    const aliceRecoveryToken = aliceKeys?.recoveryToken ?? undefined;
    const secretSubmitted = useRef(false);
    useEffect(() => {
        if (!secretHex || secretSubmitted.current || !aliceRecoveryToken) return;

        let cancelled = false;
        let attempt = 0;
        const MAX_ATTEMPTS = 30;
        const BASE_DELAY = 5_000;
        const MAX_DELAY = 120_000;

        const trySubmit = async (): Promise<boolean> => {
            const result = await submitSwapSecret(swapId.toString(), secretHex, aliceRecoveryToken, aliceViewKey, undefined, aliceSecp256k1Pub, aliceDleqProof);
            return result.ok;
        };

        const scheduleRetry = (): void => {
            if (cancelled || secretSubmitted.current || attempt >= MAX_ATTEMPTS) return;
            const delay = Math.min(BASE_DELAY * Math.pow(1.5, attempt), MAX_DELAY);
            attempt++;
            setTimeout(() => {
                if (cancelled || secretSubmitted.current) return;
                void trySubmit().then((ok) => {
                    if (ok) {
                        secretSubmitted.current = true;
                    } else {
                        scheduleRetry();
                    }
                });
            }, delay);
        };

        void trySubmit().then((ok) => {
            if (ok) {
                secretSubmitted.current = true;
            } else {
                scheduleRetry();
            }
        });

        return () => {
            cancelled = true;
        };
    }, [secretHex, aliceViewKey, aliceSecp256k1Pub, aliceDleqProof, aliceRecoveryToken, swapId]);

    // Retry submitting Bob's keys to coordinator (max 30 attempts, exponential backoff)
    const bobKeysSubmittedRef = useRef(false);
    useEffect(() => {
        if (bobKeysSubmittedRef.current || !bobKeys || !claimToken) return;

        let cancelled = false;
        let attempt = 0;
        const MAX_ATTEMPTS = 30;
        const BASE_DELAY = 5_000;
        const MAX_DELAY = 120_000;

        const trySubmit = async (): Promise<boolean> => {
            try {
                const bobSpendKeyBytes = hexToUint8Array(bobKeys.bobSpendKey);
                const bobPubBytes = hexToUint8Array(bobKeys.bobEd25519PubKey);
                const keyProof = await signBobKeyProof(bobSpendKeyBytes, bobPubBytes, swapId.toString());
                const proofHex = uint8ArrayToHex(keyProof);

                return await submitBobKeys(swapId.toString(), {
                    bobEd25519PubKey: bobKeys.bobEd25519PubKey,
                    bobViewKey: bobKeys.bobViewKey,
                    bobKeyProof: proofHex,
                    bobSpendKey: bobKeys.bobSpendKey,
                    bobSecp256k1Pub: bobKeys.bobSecp256k1Pub,
                    bobDleqProof: bobKeys.bobDleqProof,
                }, claimToken);
            } catch {
                return false;
            }
        };

        const scheduleRetry = (): void => {
            if (cancelled || bobKeysSubmittedRef.current || attempt >= MAX_ATTEMPTS) return;
            const delay = Math.min(BASE_DELAY * Math.pow(1.5, attempt), MAX_DELAY);
            attempt++;
            setTimeout(() => {
                if (cancelled || bobKeysSubmittedRef.current) return;
                void trySubmit().then((ok) => {
                    if (ok) {
                        bobKeysSubmittedRef.current = true;
                    } else {
                        scheduleRetry();
                    }
                });
            }, delay);
        };

        void trySubmit().then((ok) => {
            if (ok) {
                bobKeysSubmittedRef.current = true;
            } else {
                scheduleRetry();
            }
        });

        return () => {
            cancelled = true;
        };
    }, [bobKeys, claimToken, swapId]);

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

    // Verify counterparty's DLEQ proof when trustless mode is active.
    // Bob verifies Alice's proof; Alice verifies Bob's proof.
    // hashLockHex is in the dep array to re-verify when it becomes available
    // (proof is context-bound to hashLock to prevent cross-swap replay).
    useEffect(() => {
        if (!coordinatorStatus?.trustlessMode) return;
        // Must have hashLockHex to bind proof to this specific swap
        if (!hashLockHex) return;

        // Determine which counterparty proof to verify based on role
        let edPubHex: string | undefined;
        let secPubHex: string | undefined;
        let proofHex: string | undefined;
        let label: string;

        if (isBob && coordinatorStatus.aliceEd25519Pub && coordinatorStatus.aliceSecp256k1Pub && coordinatorStatus.aliceDleqProof) {
            edPubHex = coordinatorStatus.aliceEd25519Pub;
            secPubHex = coordinatorStatus.aliceSecp256k1Pub;
            proofHex = coordinatorStatus.aliceDleqProof;
            label = 'Alice';
        } else if (isAlice && coordinatorStatus.bobEd25519Pub && coordinatorStatus.bobSecp256k1Pub && coordinatorStatus.bobDleqProof) {
            edPubHex = coordinatorStatus.bobEd25519Pub;
            secPubHex = coordinatorStatus.bobSecp256k1Pub;
            proofHex = coordinatorStatus.bobDleqProof;
            label = 'Bob';
        } else {
            return; // Not enough data yet
        }

        // Deduplicate: only verify once per unique proof + context combo
        const checkKey = `${edPubHex}:${proofHex}:${hashLockHex}`;
        if (dleqCheckedRef.current === checkKey) return;
        dleqCheckedRef.current = checkKey;

        setDleqVerified('pending');

        void (async () => {
            try {
                const edBytes = hexToUint8Array(edPubHex!);
                const secBytes = hexToUint8Array(secPubHex!);
                const proofBytes = hexToUint8Array(proofHex!);
                const valid = await verifyDleqProof(edBytes, secBytes, proofBytes, hashLockHex);
                setDleqVerified(valid ? 'valid' : 'invalid');
                if (!valid) {
                    console.error(`[DLEQ] ${label}'s cross-curve proof FAILED verification`);
                }
            } catch (err) {
                console.error('[DLEQ] Verification error:', err);
                setDleqVerified('invalid');
            }
        })();
    }, [coordinatorStatus, isAlice, isBob, hashLockHex]);

    // Determine current progress step
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
                cs === 'xmr_sweeping' ||
                cs === 'claimed' ||
                cs === 'complete'
            ) {
                return cs;
            }
        }
        if (swap.status === 1n) return 'taken';
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

    const actionInProgressRef = useRef(false);

    const handleClaim = useCallback(async (): Promise<void> => {
        if (actionInProgressRef.current) return;
        if (!isConnected || !walletAddress || !publicKey || !senderAddress) {
            setActionError('Connect your wallet first');
            return;
        }
        if (!claimablePreimage) {
            setActionError('No secret available. Enter your 12 recovery words to claim.');
            return;
        }
        if (coordinatorStatus?.trustlessMode && dleqVerified === 'invalid') {
            setActionError('DLEQ proof verification failed — claim blocked for safety.');
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

    // Handle mnemonic recovery on page refresh
    const [recoveryError, setRecoveryError] = useState<string | null>(null);
    const handleMnemonicRecover = useCallback((mnemonic: string) => {
        setRecoveryError(null);
        void (async () => {
            // Try Alice first
            const alice = await deriveAliceKeys(mnemonic);
            // Check if hashLock matches the swap
            if (swap && swap.hashLock === alice.hashLock) {
                setSession({
                    swapId: swapId.toString(),
                    role: 'alice',
                    mnemonic: '',
                    aliceKeys: alice,
                    bobKeys: null,
                });
                return;
            }

            // Try Bob — verify derived keys match this swap
            const bob = await deriveBobKeys(mnemonic, swapHashLockHex ?? undefined);

            // Primary check: compare pubkey against coordinator's stored bob_ed25519_pub
            if (coordinatorStatus?.bobEd25519Pub) {
                if (bob.bobEd25519PubKey.toLowerCase() !== coordinatorStatus.bobEd25519Pub.toLowerCase()) {
                    setRecoveryError('This mnemonic does not match this swap. Check your recovery words or try a different swap ID.');
                    return;
                }
            } else {
                // Coordinator has no bob_ed25519_pub — try claim_token lookup first,
                // then fall back to submitting bob keys (for on-chain imported swaps).
                const COORDINATOR_BASE = import.meta.env.VITE_COORDINATOR_URL as string;
                let verified = false;
                if (COORDINATOR_BASE && /^[0-9a-f]{64}$/i.test(bob.claimTokenHex)) {
                    try {
                        const res = await fetch(
                            `${COORDINATOR_BASE}/api/swaps/by-claim-token/${bob.claimTokenHex}`,
                            { signal: AbortSignal.timeout(10000) },
                        );
                        if (res.ok) {
                            const body = (await res.json()) as { data?: { swap_id?: string } };
                            const matchedId = body.data?.swap_id;
                            if (matchedId && matchedId !== swapId.toString()) {
                                setRecoveryError('This mnemonic belongs to a different swap. Check your recovery words or swap ID.');
                                return;
                            }
                            verified = true;
                        }
                        // 404 = claim_token not found — fall through to key submission
                    } catch {
                        setRecoveryError('Cannot verify mnemonic — coordinator is unreachable. Please try again when the coordinator is online.');
                        return;
                    }
                }
                // If claim_token didn't verify, try submitting bob keys directly.
                // This handles swaps imported from on-chain where no claim_token exists.
                if (!verified) {
                    const submitted = await submitBobKeys(
                        swapId.toString(),
                        {
                            bobEd25519PubKey: bob.bobEd25519PubKey,
                            bobViewKey: bob.bobViewKey,
                            bobKeyProof: bob.bobKeyProof,
                        },
                    );
                    if (!submitted) {
                        setRecoveryError('This mnemonic does not match any known swap. Check your recovery words.');
                        return;
                    }
                }
            }

            setSession({
                swapId: swapId.toString(),
                role: 'bob',
                mnemonic: '',
                aliceKeys: null,
                bobKeys: bob,
            });
        })();
    }, [swap, swapId, setSession, coordinatorStatus]);

    const isDepositor = swap !== null && senderAddress !== null &&
        swap.depositor.toLowerCase() === senderAddress.toString().toLowerCase();

    const xmrClaimDone =
        coordinatorStatus !== null &&
        coordinatorStatus.sweepStatus?.startsWith('done:');

    const xmrClaimPending =
        coordinatorStatus !== null &&
        coordinatorStatus.sweepStatus === 'pending';

    // If no session keys and not a terminal state, show mnemonic input
    const needsRecovery = !isSessionActive && swap !== null && swap.status < 2n;

    if (needsRecovery) {
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

                <div className="glass-card" style={{ padding: '24px' }}>
                    <p
                        style={{
                            fontSize: '0.9rem',
                            fontWeight: 600,
                            color: 'var(--color-text-warning)',
                            marginBottom: '4px',
                        }}
                    >
                        Session Expired
                    </p>
                    <p
                        style={{
                            fontSize: '0.82rem',
                            color: 'var(--color-text-secondary)',
                            marginBottom: '16px',
                        }}
                    >
                        Enter your 12 recovery words to restore access to this swap.
                    </p>
                    <MnemonicInput onSubmit={handleMnemonicRecover} submitLabel="Restore Access" />
                    {recoveryError && (
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
                            {recoveryError}
                        </div>
                    )}
                </div>
            </div>
        );
    }

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
                            {currentStep === 'xmr_sweeping' && (isAlice ? 'Securing your XMR...' : 'XMR being secured for seller')}
                            {currentStep === 'claimed' && ((isAlice || isDepositor)
                                ? (xmrClaimDone ? 'XMR sent to your wallet' : xmrClaimPending ? 'Sending XMR...' : 'Claim your XMR')
                                : 'Swap complete')}
                        </p>
                        <p style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
                            {currentStep === 'created' && (isAlice
                                ? 'Your MOTO is locked on-chain. Waiting for someone to take your swap. OPNet blocks take 3-5 minutes.'
                                : 'Your take transaction is confirming on-chain. OPNet blocks take 3-5 minutes — this page updates automatically.')}
                            {currentStep === 'taken' && (isAlice
                                ? 'Someone accepted your swap! The coordinator is setting up the XMR escrow address. This is automatic.'
                                : isBob && coordinatorStatus?.step === 'created'
                                    ? 'Your take transaction is confirming on-chain. OPNet blocks take 3-5 minutes. Once confirmed, XMR escrow setup begins automatically.'
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
                            {currentStep === 'xmr_sweeping' && (isAlice
                                ? 'XMR is being sent to your Monero wallet. Once complete, the buyer can claim MOTO. No action needed.'
                                : 'XMR is being secured for the seller. You\'ll be able to claim MOTO once this step completes — usually 1-2 minutes.')}
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

            {/* Recovery words reminder — show during active swap states */}
            {isSessionActive && currentStep !== 'complete' && swap !== null && swap.status < 2n && (
                <div
                    style={{
                        padding: '10px 14px',
                        background: 'rgba(255, 215, 64, 0.04)',
                        border: '1px solid rgba(255, 215, 64, 0.12)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '12px',
                        fontSize: '0.75rem',
                        color: 'var(--color-text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                    }}
                >
                    <span style={{ color: 'var(--color-text-warning)', fontWeight: 700, flexShrink: 0 }}>REMINDER</span>
                    <span>
                        If you close this tab, you will need your <strong style={{ color: 'var(--color-text-secondary)' }}>12 recovery words</strong> to return to this swap.
                    </span>
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

            {/* DLEQ Verification Status */}
            {coordinatorStatus?.trustlessMode && dleqVerified === 'invalid' && (
                <div
                    style={{
                        padding: '14px 16px',
                        background: 'rgba(255, 82, 82, 0.12)',
                        border: '2px solid rgba(255, 82, 82, 0.5)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '16px',
                        fontSize: '0.875rem',
                        color: 'var(--color-text-error)',
                    }}
                >
                    <strong>SECURITY WARNING: DLEQ proof verification failed.</strong>{' '}
                    The counterparty&apos;s cross-curve key binding could not be verified. The lock address may not be jointly controlled.{' '}
                    <strong>Do NOT proceed with this swap.</strong>
                </div>
            )}
            {coordinatorStatus?.trustlessMode && dleqVerified === 'valid' && (
                <div
                    style={{
                        padding: '10px 14px',
                        background: 'rgba(0, 230, 118, 0.06)',
                        border: '1px solid rgba(0, 230, 118, 0.2)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '16px',
                        fontSize: '0.8rem',
                        color: 'var(--color-text-success)',
                    }}
                >
                    Cross-curve key binding verified (DLEQ proof valid)
                </div>
            )}

            {/* XMR Lock Address */}
            {coordinatorStatus !== null &&
                coordinatorStatus.xmrLockAddress !== undefined &&
                /^[48][1-9A-HJ-NP-Za-km-z]{94}$/.test(coordinatorStatus.xmrLockAddress) &&
                (coordinatorStatus.step === 'xmr_locking' || coordinatorStatus.step === 'xmr_locked' || coordinatorStatus.step === 'xmr_sweeping') && (
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
                    timeout.{' '}
                    {(isAlice || isDepositor)
                        ? 'If the swap does not complete, you can request a refund after the timeout expires.'
                        : 'If the swap does not complete before timeout, the depositor can reclaim their MOTO.'}
                </div>
            )}

            {/* Expired */}
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

            {/* Claim button or waiting message */}
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
                        Claim transaction broadcast. Waiting for on-chain confirmation (1-2 blocks, ~3-10 min). The page will update automatically.
                    </p>
                </div>
            ) : swap !== null && swap.status < 2n && currentStep !== 'complete' && (
                (() => {
                    const canClaim =
                        claimablePreimage !== null &&
                        !isAlice &&
                        coordinatorStatus !== null &&
                        (coordinatorStatus.step === 'xmr_locked' || coordinatorStatus.step === 'claimed');

                    // Block claim if DLEQ verification failed in trustless mode
                    const dleqBlocked = coordinatorStatus?.trustlessMode && dleqVerified === 'invalid';

                    if (canClaim) {
                        return (
                            <button
                                className="btn btn-primary btn-lg"
                                style={{ width: '100%', marginBottom: '12px' }}
                                disabled={!isConnected || !!dleqBlocked}
                                onClick={() => void handleClaim()}
                                title={dleqBlocked ? 'Claim disabled — DLEQ proof verification failed' : undefined}
                            >
                                {dleqBlocked ? 'Claim Blocked — DLEQ Failed' : 'Claim MOTO (reveal secret)'}
                            </button>
                        );
                    }

                    const waitingMessages: Record<string, string> = {
                        created: isAlice
                            ? 'Waiting for someone to take your swap. Your MOTO is safely locked on-chain.'
                            : 'Connecting with seller. Your take transaction is confirming on-chain — OPNet blocks take 3-5 minutes.',
                        taken: isAlice
                            ? 'A counterparty accepted your swap! The coordinator is setting up the XMR escrow. This is automatic — no action needed.'
                            : 'You accepted this swap. Waiting for on-chain confirmation and XMR escrow setup. OPNet blocks take 3-5 minutes.',
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
                        xmr_sweeping: isAlice
                            ? 'XMR is being sent to your Monero wallet. Once this completes, the buyer can claim MOTO.'
                            : 'XMR is being secured for the seller. You\'ll be able to claim MOTO once the secret is delivered.',
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

            {/* Cancel */}
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

            {/* Refund */}
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
