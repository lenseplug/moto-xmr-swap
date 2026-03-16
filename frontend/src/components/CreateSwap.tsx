/**
 * CreateSwap form component — allows users to create a new MOTO/XMR atomic swap.
 * Uses BIP39 mnemonic for key derivation — zero localStorage.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { networks } from '@btc-vision/bitcoin';
import { getSwapVaultContract, getMotoContract, parseMotoAmount, parseXmrAmount, splitXmrAddress, getProvider } from '../services/opnet';
import { hashSecret } from '../utils/hashlock';
import { generateSwapMnemonic, deriveAliceKeys } from '../utils/mnemonic';
import { submitSwapSecret, resolveSwapIdByHashLock, backupSecret } from '../services/coordinator';
import { useSwapSession } from '../contexts/SwapSessionContext';
import { MnemonicDisplay } from './MnemonicDisplay';
import { PrivacyBanner } from './PrivacyBanner';
import { ExplorerLinks } from './ExplorerLinks';

const SWAP_VAULT_ADDRESS = import.meta.env.VITE_SWAP_VAULT_ADDRESS;
const MOTO_TOKEN_ADDRESS = import.meta.env.VITE_MOTO_TOKEN_ADDRESS;
const BLOCKS_PER_HOUR = 6;
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

export function CreateSwap({ onSwapCreated }: CreateSwapProps): React.ReactElement {
    const { publicKey, address: senderAddress, walletAddress } = useWalletConnect();
    const { setSession } = useSwapSession();

    const isConnected = publicKey !== null;

    const [form, setForm] = useState<FormState>({
        motoAmount: '',
        xmrAmount: '',
        xmrAddress: '',
        timeoutBlocks: String(DEFAULT_TIMEOUT_BLOCKS),
    });

    const [step, setStep] = useState<
        'idle' | 'checking_allowance' | 'approving' | 'mnemonic' | 'creating' | 'done' | 'error'
    >('idle');

    const [statusMessage, setStatusMessage] = useState<string>('');
    const [txResult, setTxResult] = useState<TxResult | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [mnemonic, setMnemonic] = useState<string | null>(null);

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

    const cancelledRef = useRef(false);

    const handleCancel = useCallback((): void => {
        cancelledRef.current = true;
        setStep('idle');
        setStatusMessage('');
        setMnemonic(null);
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

    // Step 1: Validate + check allowance + approve if needed, then show mnemonic
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

        setFormError(null);
        cancelledRef.current = false;

        try {
            // Check existing allowance
            setStep('checking_allowance');
            setStatusMessage('Checking MOTO allowance...');

            const swapContract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);
            const vaultAddress = await swapContract.contractAddress;

            const motoContract = getMotoContract(MOTO_TOKEN_ADDRESS, senderAddress);
            const allowanceResult = await motoContract.allowance(senderAddress, vaultAddress);
            if ('error' in allowanceResult) {
                throw new Error(`Allowance check failed: ${String(allowanceResult.error)}`);
            }

            const currentAllowance = allowanceResult.properties.remaining;

            if (currentAllowance < motoAmount) {
                setStep('approving');
                setStatusMessage('Approving MOTO for SwapVault...');

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

                setStatusMessage('Approving MOTO — waiting for block confirmation...');
                const maxWaitMs = 10 * 60 * 1000;
                const pollMs = 5_000;
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

            // Generate mnemonic and show it
            const words = generateSwapMnemonic();
            setMnemonic(words);
            setStep('mnemonic');
        } catch (err) {
            setStep('error');
            setStatusMessage(err instanceof Error ? err.message : 'Unknown error occurred');
        }
    }, [isConnected, walletAddress, publicKey, senderAddress, form, validateForm]);

    // Step 2: User confirmed they wrote down words -> proceed with on-chain tx
    const handleMnemonicConfirmed = useCallback(async (): Promise<void> => {
        if (!mnemonic || !senderAddress || !walletAddress) return;
        if (!SWAP_VAULT_ADDRESS) return;

        const motoAmount = parseMotoAmount(form.motoAmount);
        const xmrAmount = parseXmrAmount(form.xmrAmount);
        const timeoutBlocks = BigInt(parseInt(form.timeoutBlocks, 10));

        setStep('creating');
        setStatusMessage('Deriving swap keys from mnemonic...');

        try {
            const aliceKeys = await deriveAliceKeys(mnemonic);

            // Verify secret matches hashLock
            const verifyHash = await hashSecret(aliceKeys.secret);
            if (verifyHash !== aliceKeys.hashLock) {
                throw new Error('BUG: SHA-256(secret) does not match hashLock — key derivation failed');
            }

            const xmrHex = form.xmrAddress.trim();
            const { hi: xmrAddressHi, lo: xmrAddressLo } = splitXmrAddress(xmrHex);

            // Pre-register secret + recovery_token with coordinator before on-chain tx.
            // This ensures the recovery_token is applied when the OPNet watcher creates the swap.
            setStatusMessage('Backing up swap secret with coordinator...');
            const backupResult = await backupSecret(
                aliceKeys.hashLockHex,
                aliceKeys.secret,
                aliceKeys.recoveryToken,
                aliceKeys.aliceViewKey,
                xmrHex,
            );
            if (!backupResult.ok) {
                console.warn('[CreateSwap] Secret backup failed (non-fatal):', backupResult.error);
            }

            const provider = getProvider();
            const currentBlockRaw: unknown = await provider.getBlockNumber();
            const currentBlock =
                typeof currentBlockRaw === 'bigint'
                    ? currentBlockRaw
                    : BigInt(currentBlockRaw as number);
            const refundBlock = currentBlock + timeoutBlocks + 20n;

            setStatusMessage('Simulating swap creation...');

            const swapContract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);
            let createSim: Awaited<ReturnType<typeof swapContract.createSwap>> | null = null;
            const maxRetries = 36;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const simResult = await swapContract.createSwap(
                        aliceKeys.hashLock,
                        refundBlock,
                        motoAmount,
                        xmrAmount,
                        xmrAddressHi,
                        xmrAddressLo,
                    );

                    if ('error' in simResult) {
                        const errMsg = String(simResult.error);
                        if (errMsg.includes('llowance') && attempt < maxRetries) {
                            throw new Error(errMsg);
                        }
                        throw new Error(`Swap simulation failed: ${errMsg}`);
                    }

                    createSim = simResult;
                    break;
                } catch (simErr: unknown) {
                    const errMsg = simErr instanceof Error ? simErr.message : String(simErr);

                    if (errMsg.toLowerCase().includes('allowance') && attempt < maxRetries) {
                        setStep('approving');
                        setStatusMessage(`Approving MOTO — waiting for block confirmation (${attempt}/${maxRetries})...`);
                        await new Promise<void>((r) => setTimeout(r, 5_000));
                        continue;
                    }

                    throw new Error(`Swap simulation failed: ${errMsg}`);
                }
            }

            if (createSim === null) {
                throw new Error('Swap simulation failed: allowance not confirmed after retries. Try again in a few minutes.');
            }

            let swapId = 0n;
            if (createSim.properties && typeof createSim.properties === 'object') {
                const props = createSim.properties as Record<string, unknown>;
                if (typeof props['swapId'] === 'bigint') {
                    swapId = props['swapId'];
                }
            }
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

            if (cancelledRef.current) return;

            setStep('creating');
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
                throw new Error(`Swap transaction failed: ${String(receiptObj['error'])}`);
            }

            const txId =
                typeof receiptObj['result'] === 'string'
                    ? receiptObj['result']
                    : typeof receiptObj['txid'] === 'string'
                      ? receiptObj['txid']
                      : 'pending';

            // Resolve actual on-chain swap ID
            setStatusMessage('Verifying swap ID on-chain...');
            let resolvedSwapId = swapId;
            for (let attempt = 0; attempt < 36; attempt++) {
                if (cancelledRef.current) break;
                const actualId = await resolveSwapIdByHashLock(aliceKeys.hashLockHex);
                if (actualId !== null) {
                    const actualBigInt = BigInt(actualId);
                    if (actualBigInt !== swapId) {
                        console.warn(`[CreateSwap] Swap ID corrected: simulated=${swapId}, actual=${actualId}`);
                        resolvedSwapId = actualBigInt;
                    }
                    break;
                }
                if (attempt < 35) {
                    await new Promise<void>((r) => setTimeout(r, 5_000));
                }
            }

            // Submit secret to coordinator
            const aliceXmrPayout = form.xmrAddress.trim();
            setStatusMessage('Securing swap secret with coordinator (required)...');
            let secretSubmitted = false;
            for (let attempt = 0; attempt < 60; attempt++) {
                if (cancelledRef.current) break;
                const result = await submitSwapSecret(
                    resolvedSwapId.toString(),
                    aliceKeys.secret,
                    aliceKeys.recoveryToken,
                    aliceKeys.aliceViewKey,
                    aliceXmrPayout,
                    aliceKeys.aliceSecp256k1Pub,
                    aliceKeys.aliceDleqProof,
                );
                if (result.ok) {
                    secretSubmitted = true;
                    break;
                }
                if (attempt < 59) {
                    await new Promise<void>((r) => setTimeout(r, 5_000));
                }
            }

            if (!secretSubmitted) {
                setFormError(
                    'Your swap was created on-chain but the coordinator could not store your secret. ' +
                    'Keep your 12 recovery words safe. Navigate to "Recover" tab to retry.',
                );
                setStep('idle');
                return;
            }

            // Set session context — clear mnemonic from memory after keys are derived
            setSession({
                swapId: resolvedSwapId.toString(),
                role: 'alice',
                mnemonic: '',
                aliceKeys,
                bobKeys: null,
            });
            setMnemonic(null);

            setTxResult({ txId, swapId: resolvedSwapId });
            setStep('done');
            onSwapCreated(resolvedSwapId);
        } catch (err) {
            setStep('error');
            setStatusMessage(err instanceof Error ? err.message : 'Unknown error occurred');
        }
    }, [mnemonic, senderAddress, walletAddress, form, setSession, onSwapCreated]);

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

    // Show mnemonic display when words are generated
    if (step === 'mnemonic' && mnemonic) {
        return (
            <div style={{ maxWidth: '560px' }}>
                <div style={{ marginBottom: '24px' }}>
                    <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '6px' }}>
                        Create Swap
                    </h2>
                    <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                        Step 2: Save your recovery words before the swap is created on-chain.
                    </p>
                </div>
                <MnemonicDisplay mnemonic={mnemonic} onConfirm={() => void handleMnemonicConfirmed()} />
            </div>
        );
    }

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
                    Offer MOTO tokens in exchange for Monero. You will be given 12 recovery words — have pen and paper ready.
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
                            min="60"
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
                                    color: 'var(--color-text-warning)',
                                    marginTop: '6px',
                                    fontWeight: 600,
                                }}
                            >
                                Your 12 recovery words are the ONLY way to recover this swap. Keep them safe.
                            </p>
                            <ExplorerLinks txId={txResult.txId} address={walletAddress ?? undefined} />
                        </div>
                    )}

                    {/* Submit */}
                    {step !== 'done' && step !== 'mnemonic' && (
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
                                setMnemonic(null);
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
