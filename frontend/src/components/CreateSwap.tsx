/**
 * CreateSwap form component — allows users to create a new MOTO/XMR atomic swap.
 */
import React, { useState, useCallback, useRef } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { networks } from '@btc-vision/bitcoin';
import { getSwapVaultContract, getMotoContract, parseMotoAmount, parseXmrAmount, splitXmrAddress, getProvider } from '../services/opnet';
import { generateTrustlessSecret, saveLocalSwapSecret, clearLocalSwapSecret, updateLocalSwapSecretId, hashSecret } from '../utils/hashlock';
import { submitSwapSecret, resolveSwapIdByHashLock } from '../services/coordinator';
import { PrivacyBanner } from './PrivacyBanner';
import { ExplorerLinks } from './ExplorerLinks';

const SWAP_VAULT_ADDRESS = import.meta.env.VITE_SWAP_VAULT_ADDRESS;
const MOTO_TOKEN_ADDRESS = import.meta.env.VITE_MOTO_TOKEN_ADDRESS;
const BLOCKS_PER_HOUR = 6;
// Coordinator requires at least 50 blocks remaining when locking XMR.
// TODO(mainnet): Review and adjust for mainnet block times
const DEFAULT_TIMEOUT_BLOCKS = 80;

interface CreateSwapProps {
    readonly onSwapCreated: (swapId: bigint) => void;
}

interface FormState {
    motoAmount: string;
    xmrAmount: string;
    xmrAddress: string;
    timeoutBlocks: string;
}

interface TxResult {
    txId: string;
    swapId: bigint;
}

/**
 * Create swap form with allowance check and hash-lock generation.
 */
export function CreateSwap({ onSwapCreated }: CreateSwapProps): React.ReactElement {
    const { publicKey, address: senderAddress, walletAddress } = useWalletConnect();

    const isConnected = publicKey !== null;

    const [form, setForm] = useState<FormState>({
        motoAmount: '',
        xmrAmount: '',
        xmrAddress: '',
        timeoutBlocks: String(DEFAULT_TIMEOUT_BLOCKS),
    });

    const [step, setStep] = useState<
        'idle' | 'checking_allowance' | 'approving' | 'creating' | 'done' | 'error'
    >('idle');

    const [statusMessage, setStatusMessage] = useState<string>('');
    const [txResult, setTxResult] = useState<TxResult | null>(null);
    const [formError, setFormError] = useState<string | null>(null);

    // Cancellation support — aborting before the wallet prompt is shown
    const cancelledRef = useRef(false);

    const handleCancel = useCallback((): void => {
        cancelledRef.current = true;
        setStep('idle');
        setStatusMessage('');
        setFormError('Swap creation cancelled.');
    }, []);

    const handleFieldChange = useCallback(
        (field: keyof FormState) =>
            (e: React.ChangeEvent<HTMLInputElement>): void => {
                setForm((prev) => ({ ...prev, [field]: e.target.value }));
                setFormError(null);
            },
        [],
    );

    const validateForm = useCallback((): string | null => {
        const moto = parseMotoAmount(form.motoAmount);
        if (moto <= 0n) return 'MOTO amount must be greater than zero';

        const xmr = parseXmrAmount(form.xmrAmount);
        if (xmr <= 0n) return 'XMR amount must be greater than zero';
        if (xmr < 25_000_000_000n) return 'Minimum XMR amount is 0.025 XMR. Amounts below this may result in lost funds due to network fees exceeding the swap fee.';

        if (form.xmrAddress.trim().length < 10) return 'Please enter a valid XMR address';

        const blocks = parseInt(form.timeoutBlocks, 10);
        if (isNaN(blocks) || blocks < 60 || blocks > 10000)
            return 'Timeout must be between 60 and 10,000 blocks (coordinator needs at least 50 blocks to lock XMR safely)';

        return null;
    }, [form]);

    const handleSubmit = useCallback(async (): Promise<void> => {
        if (!isConnected || !walletAddress || !publicKey || !senderAddress) {
            setFormError('Please connect your wallet first');
            return;
        }

        const validationError = validateForm();
        if (validationError !== null) {
            setFormError(validationError);
            return;
        }

        if (!SWAP_VAULT_ADDRESS || !MOTO_TOKEN_ADDRESS) {
            setFormError('Contract addresses not configured. Set VITE_SWAP_VAULT_ADDRESS and VITE_MOTO_TOKEN_ADDRESS.');
            return;
        }
        const motoAmount = parseMotoAmount(form.motoAmount);
        const xmrAmount = parseXmrAmount(form.xmrAmount);
        const timeoutBlocks = BigInt(parseInt(form.timeoutBlocks, 10));

        setFormError(null);
        cancelledRef.current = false;

        try {
            // Step 1: Check existing allowance
            setStep('checking_allowance');
            setStatusMessage('Checking MOTO allowance...');

            // Initialise both contracts first so we can resolve the vault's Address.
            const swapContract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);
            const vaultAddress = await swapContract.contractAddress;

            const motoContract = getMotoContract(MOTO_TOKEN_ADDRESS, senderAddress);
            const allowanceResult = await motoContract.allowance(senderAddress, vaultAddress);
            if ('error' in allowanceResult) {
                throw new Error(`Allowance check failed: ${String(allowanceResult.error)}`);
            }

            const currentAllowance = allowanceResult.properties.remaining;

            // Step 2: Approve if needed — use a large blanket approval so we only do this once
            if (currentAllowance < motoAmount) {
                setStep('approving');
                setStatusMessage('Approving MOTO for SwapVault...');

                // Use increaseAllowance with exact deficit to prevent accumulation over repeated create/cancel cycles
                const deficit = motoAmount - currentAllowance;
                const approveSim = await motoContract.increaseAllowance(vaultAddress, deficit);
                if ('error' in approveSim) {
                    throw new Error(`Allowance simulation failed: ${String(approveSim.error)}`);
                }

                const approveReceipt = await approveSim.sendTransaction({
                    signer: null,
                    mldsaSigner: null,
                    linkMLDSAPublicKeyToAddress: true,
                    refundTo: walletAddress,
                    maximumAllowedSatToSpend: 100_000n,
                    network: networks.opnetTestnet,
                });

                const approveObj = approveReceipt as unknown as Record<string, unknown>;
                if ('error' in approveObj) {
                    throw new Error(`Allowance transaction failed: ${String(approveObj['error'])}`);
                }

                // Wait for the approval to be confirmed on-chain by polling allowance
                setStatusMessage('Approving MOTO — waiting for block confirmation...');
                const maxWaitMs = 10 * 60 * 1000; // 10 minutes max
                const pollMs = 5_000; // check every 5s
                const startTime = Date.now();
                let confirmed = false;

                while (Date.now() - startTime < maxWaitMs) {
                    await new Promise<void>((r) => setTimeout(r, pollMs));
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    setStatusMessage(`Approving MOTO — waiting for block confirmation (${elapsed}s)...`);
                    try {
                        const recheckResult = await motoContract.allowance(senderAddress, vaultAddress);
                        if (!('error' in recheckResult) && recheckResult.properties.remaining >= motoAmount) {
                            confirmed = true;
                            break;
                        }
                    } catch {
                        // RPC hiccup — keep polling
                    }
                }

                if (!confirmed) {
                    throw new Error('Approval timed out — the allowance TX may still be pending. Try again in a few minutes.');
                }
            }

            // Step 3: Generate ed25519 split keys + hash-lock
            setStep('creating');
            setStatusMessage('Generating swap keys...');

            const { secret, hashLock, hashLockHex, aliceViewKey } = await generateTrustlessSecret();

            // Verify secret matches hashLock locally (defensive assertion)
            const verifyHash = await hashSecret(secret);
            if (verifyHash !== hashLock) {
                throw new Error('BUG: SHA-256(secret) does not match hashLock — key generation failed');
            }

            // Step 4: Encode XMR address
            const xmrHex = form.xmrAddress.trim();
            const { hi: xmrAddressHi, lo: xmrAddressLo } = splitXmrAddress(xmrHex);

            // Step 5: Get current block for refundBlock
            const provider = getProvider();
            const currentBlockRaw: unknown = await provider.getBlockNumber();
            const currentBlock =
                typeof currentBlockRaw === 'bigint'
                    ? currentBlockRaw
                    : BigInt(currentBlockRaw as number);
            // Add a 20-block safety buffer to account for blocks that may elapse
            // between the block number fetch and the transaction being mined.
            const refundBlock = currentBlock + timeoutBlocks + 20n;

            // Step 6: Simulate createSwap with retry (allowance may need a block to confirm)
            // OPNet simulations can throw OR return error objects, so we handle both.
            setStatusMessage('Simulating swap creation...');

            let createSim: Awaited<ReturnType<typeof swapContract.createSwap>> | null = null;
            const maxRetries = 36; // up to ~3 minutes of retries
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const simResult = await swapContract.createSwap(
                        hashLock,
                        refundBlock,
                        motoAmount,
                        xmrAmount,
                        xmrAddressHi,
                        xmrAddressLo,
                    );

                    if ('error' in simResult) {
                        const errMsg = String(simResult.error);
                        if (errMsg.includes('llowance') && attempt < maxRetries) {
                            // Allowance not confirmed yet — keep waiting
                            throw new Error(errMsg);
                        }
                        throw new Error(`Swap simulation failed: ${errMsg}`);
                    }

                    createSim = simResult;
                    break;
                } catch (simErr: unknown) {
                    const errMsg = simErr instanceof Error ? simErr.message : String(simErr);

                    // Retry on allowance errors (case-insensitive partial match)
                    if (errMsg.toLowerCase().includes('allowance') && attempt < maxRetries) {
                        setStep('approving');
                        setStatusMessage(`Approving MOTO — waiting for block confirmation (${attempt}/${maxRetries})...`);
                        await new Promise<void>((r) => setTimeout(r, 5_000));
                        continue;
                    }

                    // Non-allowance error or last retry — give up
                    throw new Error(`Swap simulation failed: ${errMsg}`);
                }
            }

            if (createSim === null) {
                throw new Error('Swap simulation failed: allowance not confirmed after retries. Try again in a few minutes.');
            }

            // Extract swapId from simulation BEFORE sending transaction
            let swapId = 0n;

            // Try the simulation return value first (most reliable)
            if (createSim.properties && typeof createSim.properties === 'object') {
                const props = createSim.properties as Record<string, unknown>;
                if (typeof props['swapId'] === 'bigint') {
                    swapId = props['swapId'];
                }
            }

            // Fallback: try events
            if (swapId === 0n) {
                const events = createSim.events ?? [];
                if (events.length > 0) {
                    const firstEvent = events[0];
                    if (firstEvent !== undefined && typeof firstEvent === 'object' && firstEvent !== null) {
                        const evtRecord = firstEvent as unknown as Record<string, unknown>;
                        const vals = evtRecord['values'] as Record<string, unknown> | undefined;
                        if (vals !== undefined && typeof vals['swapId'] === 'bigint') {
                            swapId = vals['swapId'];
                        }
                    }
                }
            }


            // Save secret to localStorage as CACHE (not authoritative).
            const aliceXmrPayout = form.xmrAddress.trim();
            saveLocalSwapSecret(swapId.toString(), secret, hashLockHex, aliceViewKey, aliceXmrPayout);

            // Check for cancellation before requesting wallet signature
            if (cancelledRef.current) return;

            // Step 7: Send transaction
            setStatusMessage('Waiting for wallet signature...');

            const createReceipt = await createSim.sendTransaction({
                signer: null,
                mldsaSigner: null,
                refundTo: walletAddress,
                maximumAllowedSatToSpend: 200_000n,
                network: networks.opnetTestnet,
            });

            const receiptObj = createReceipt as unknown as Record<string, unknown>;

            if ('error' in receiptObj) {
                // Clean up saved secret if tx failed
                clearLocalSwapSecret(swapId.toString());
                throw new Error(`Swap transaction failed: ${String(receiptObj['error'])}`);
            }

            const txId =
                typeof receiptObj['result'] === 'string'
                    ? receiptObj['result']
                    : typeof receiptObj['txid'] === 'string'
                      ? receiptObj['txid']
                      : 'pending';

            // Step 8: Resolve the ACTUAL on-chain swap ID via coordinator.
            // The simulation swap ID may differ if another swap was mined between
            // simulation and confirmation (race condition).
            setStatusMessage('Verifying swap ID on-chain...');
            let resolvedSwapId = swapId;
            for (let attempt = 0; attempt < 36; attempt++) {
                if (cancelledRef.current) break;
                const actualId = await resolveSwapIdByHashLock(hashLockHex);
                if (actualId !== null) {
                    const actualBigInt = BigInt(actualId);
                    if (actualBigInt !== swapId) {
                        console.warn(`[CreateSwap] Swap ID corrected: simulated=${swapId}, actual=${actualId}`);
                        updateLocalSwapSecretId(swapId.toString(), actualId);
                        resolvedSwapId = actualBigInt;
                    }
                    break;
                }
                // Coordinator hasn't detected the swap yet — wait and retry
                if (attempt < 35) {
                    await new Promise<void>((r) => setTimeout(r, 5_000));
                }
            }

            // BLOCKING: Submit secret to coordinator. Do NOT show success until confirmed.
            // The coordinator is the authoritative store — localStorage is just a cache.
            setStatusMessage('Securing swap secret with coordinator (required)...');
            let secretSubmitted = false;
            for (let attempt = 0; attempt < 60; attempt++) {
                if (cancelledRef.current) break;
                const result = await submitSwapSecret(resolvedSwapId.toString(), secret, aliceViewKey, aliceXmrPayout);
                if (result.ok) {
                    secretSubmitted = true;
                    break;
                }
                if (attempt < 59) {
                    await new Promise<void>((r) => setTimeout(r, 5_000));
                }
            }

            if (!secretSubmitted) {
                // CRITICAL: Do NOT show success. Secret is only in localStorage (cache).
                setFormError(
                    'Your swap was created on-chain but the coordinator could not store your secret. ' +
                    'Your secret is saved locally. DO NOT clear browser data. ' +
                    'Navigate to your swap to retry automatically.',
                );
                setStep('idle');
                return;
            }

            setTxResult({ txId, swapId: resolvedSwapId });
            setStep('done');
            onSwapCreated(resolvedSwapId);
        } catch (err) {
            setStep('error');
            setStatusMessage(err instanceof Error ? err.message : 'Unknown error occurred');
        }
    }, [
        isConnected,
        walletAddress,
        publicKey,
        senderAddress,
        form,
        validateForm,
        onSwapCreated,
    ]);

    const estimatedHours = Math.round(parseInt(form.timeoutBlocks || '0', 10) / BLOCKS_PER_HOUR);

    const isProcessing = step === 'checking_allowance' || step === 'approving' || step === 'creating';

    const fieldLabel: React.CSSProperties = {
        display: 'block',
        fontSize: '0.8rem',
        fontWeight: 600,
        color: 'var(--color-text-secondary)',
        marginBottom: '6px',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
    };

    return (
        <div style={{ maxWidth: '560px' }}>
            <div style={{ marginBottom: '24px' }}>
                <h2
                    style={{
                        fontSize: '1.35rem',
                        fontWeight: 700,
                        marginBottom: '6px',
                    }}
                >
                    Create Swap
                </h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                    Offer MOTO tokens in exchange for Monero. Split ed25519 keys are generated locally.
                </p>
            </div>

            {!isConnected && (
                <div
                    style={{
                        padding: '16px',
                        background: 'rgba(255, 215, 64, 0.06)',
                        border: '1px solid rgba(255, 215, 64, 0.2)',
                        borderRadius: 'var(--radius-md)',
                        marginBottom: '20px',
                        fontSize: '0.875rem',
                        color: 'var(--color-text-warning)',
                    }}
                >
                    Connect your OPWallet to create a swap.
                </div>
            )}

            <div className="glass-card" style={{ padding: '24px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

                    {/* MOTO Amount */}
                    <div>
                        <label htmlFor="moto-amount" style={fieldLabel}>
                            MOTO Amount
                        </label>
                        <input
                            id="moto-amount"
                            type="text"
                            inputMode="decimal"
                            className="input-field tabular-nums"
                            placeholder="0.00"
                            value={form.motoAmount}
                            onChange={handleFieldChange('motoAmount')}
                            disabled={isProcessing || step === 'done'}
                        />
                        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                            Amount of MOTO tokens to lock in the swap vault
                        </p>
                    </div>

                    {/* XMR Amount */}
                    <div>
                        <label htmlFor="xmr-amount" style={fieldLabel}>
                            Desired XMR Amount
                        </label>
                        <input
                            id="xmr-amount"
                            type="text"
                            inputMode="decimal"
                            className="input-field tabular-nums"
                            placeholder="0.000000000000"
                            value={form.xmrAmount}
                            onChange={handleFieldChange('xmrAmount')}
                            disabled={isProcessing || step === 'done'}
                        />
                        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                            Minimum 0.025 XMR. The taker pays an additional 0.87% fee on top of this amount.
                        </p>
                        {form.xmrAmount.trim() !== '' && parseXmrAmount(form.xmrAmount) > 0n && parseXmrAmount(form.xmrAmount) < 25_000_000_000n && (
                            <p style={{
                                fontSize: '0.75rem',
                                color: 'var(--color-text-warning)',
                                marginTop: '6px',
                                padding: '8px 10px',
                                background: 'rgba(255, 215, 64, 0.08)',
                                border: '1px solid rgba(255, 215, 64, 0.25)',
                                borderRadius: 'var(--radius-sm)',
                            }}>
                                Amounts below 0.025 XMR may result in lost funds — network fees can exceed the swap fee at this size.
                            </p>
                        )}
                    </div>

                    {/* XMR Address */}
                    <div>
                        <label htmlFor="xmr-address" style={fieldLabel}>
                            Your Monero Address
                        </label>
                        <PrivacyBanner />
                        <input
                            id="xmr-address"
                            type="text"
                            className="input-field input-mono"
                            style={{ marginTop: '10px' }}
                            placeholder="4... (standard Monero address)"
                            value={form.xmrAddress}
                            onChange={handleFieldChange('xmrAddress')}
                            disabled={isProcessing || step === 'done'}
                        />
                        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                            Standard Monero address (starts with 4) or 128-char hex
                        </p>
                    </div>

                    {/* Timeout */}
                    <div>
                        <label htmlFor="timeout-blocks" style={fieldLabel}>
                            Timeout (blocks)
                        </label>
                        <input
                            id="timeout-blocks"
                            type="number"
                            min="10"
                            max="10000"
                            className="input-field tabular-nums"
                            value={form.timeoutBlocks}
                            onChange={handleFieldChange('timeoutBlocks')}
                            disabled={isProcessing || step === 'done'}
                        />
                        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '4px' }}>
                            {isNaN(parseInt(form.timeoutBlocks, 10))
                                ? 'Invalid'
                                : `~${estimatedHours} hour${estimatedHours !== 1 ? 's' : ''} at 6 blocks/hour`}
                        </p>
                    </div>

                    {/* Error */}
                    {formError !== null && (
                        <div
                            style={{
                                padding: '12px 14px',
                                background: 'rgba(255, 82, 82, 0.08)',
                                border: '1px solid rgba(255, 82, 82, 0.25)',
                                borderRadius: 'var(--radius-md)',
                                color: 'var(--color-text-error)',
                                fontSize: '0.875rem',
                            }}
                        >
                            {formError}
                        </div>
                    )}

                    {/* Status + Cancel */}
                    {isProcessing && (
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
                            }}
                        >
                            <div
                                style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '50%',
                                    background: 'var(--color-orange)',
                                    flexShrink: 0,
                                }}
                            />
                            <span style={{ flex: 1 }}>{statusMessage}</span>
                            <button
                                className="btn btn-ghost btn-sm"
                                style={{ color: 'var(--color-text-error)', flexShrink: 0 }}
                                onClick={handleCancel}
                            >
                                Cancel
                            </button>
                        </div>
                    )}

                    {/* Error step result */}
                    {step === 'error' && (
                        <div
                            style={{
                                padding: '12px 14px',
                                background: 'rgba(255, 82, 82, 0.08)',
                                border: '1px solid rgba(255, 82, 82, 0.25)',
                                borderRadius: 'var(--radius-md)',
                                color: 'var(--color-text-error)',
                                fontSize: '0.875rem',
                            }}
                        >
                            {statusMessage}
                        </div>
                    )}

                    {/* Success */}
                    {step === 'done' && txResult !== null && (
                        <div
                            style={{
                                padding: '16px',
                                background: 'rgba(0, 230, 118, 0.06)',
                                border: '1px solid rgba(0, 230, 118, 0.2)',
                                borderRadius: 'var(--radius-md)',
                            }}
                        >
                            <p
                                style={{
                                    fontSize: '0.9rem',
                                    fontWeight: 600,
                                    color: 'var(--color-text-success)',
                                    marginBottom: '4px',
                                }}
                            >
                                Swap Created
                            </p>
                            <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                                Swap ID: <span className="font-mono">{txResult.swapId.toString()}</span>
                            </p>
                            <p
                                style={{
                                    fontSize: '0.75rem',
                                    color: 'var(--color-text-muted)',
                                    marginTop: '6px',
                                }}
                            >
                                Swap keys saved to browser storage. Safe to refresh — do not clear browser data until the swap completes.
                            </p>
                            <ExplorerLinks txId={txResult.txId} address={walletAddress ?? undefined} />
                        </div>
                    )}

                    {/* Submit */}
                    {step !== 'done' && (
                        <button
                            className="btn btn-primary btn-lg"
                            disabled={!isConnected || isProcessing}
                            onClick={() => void handleSubmit()}
                        >
                            {isProcessing
                                ? step === 'approving'
                                    ? 'Approving MOTO...'
                                    : step === 'creating'
                                      ? 'Creating Swap...'
                                      : 'Checking Allowance...'
                                : 'Create Swap'}
                        </button>
                    )}

                    {step === 'done' && (
                        <button
                            className="btn btn-ghost"
                            onClick={() => {
                                setStep('idle');
                                setTxResult(null);
                                setForm({
                                    motoAmount: '',
                                    xmrAmount: '',
                                    xmrAddress: '',
                                    timeoutBlocks: String(DEFAULT_TIMEOUT_BLOCKS),
                                });
                            }}
                        >
                            Create Another Swap
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
