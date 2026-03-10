/**
 * CreateSwap form component — allows users to create a new MOTO/XMR atomic swap.
 */
import React, { useState, useCallback } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { networks } from '@btc-vision/bitcoin';
import { getSwapVaultContract, getMotoContract, parseMotoAmount, parseXmrAmount, splitXmrAddress, getProvider } from '../services/opnet';
import { generateTrustlessSecret, saveLocalSwapSecret, secretHexToBigint, hashSecret } from '../utils/hashlock';
import { submitSwapSecret } from '../services/coordinator';
import { PrivacyBanner } from './PrivacyBanner';
import { ExplorerLinks } from './ExplorerLinks';

const SWAP_VAULT_ADDRESS = import.meta.env.VITE_SWAP_VAULT_ADDRESS;
const MOTO_TOKEN_ADDRESS = import.meta.env.VITE_MOTO_TOKEN_ADDRESS;
const BLOCKS_PER_HOUR = 6;
const DEFAULT_TIMEOUT_BLOCKS = 100;

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

        if (form.xmrAddress.trim().length < 10) return 'Please enter a valid XMR address';

        const blocks = parseInt(form.timeoutBlocks, 10);
        if (isNaN(blocks) || blocks < 10 || blocks > 10000)
            return 'Timeout must be between 10 and 10000 blocks';

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

            // Step 2: Approve if needed
            if (currentAllowance < motoAmount) {
                const needed = motoAmount - currentAllowance;
                setStep('approving');
                setStatusMessage(`Increasing allowance by ${form.motoAmount} MOTO...`);

                const approveSim = await motoContract.increaseAllowance(vaultAddress, needed);
                if ('error' in approveSim) {
                    throw new Error(`Allowance simulation failed: ${String(approveSim.error)}`);
                }

                const approveReceipt = await approveSim.sendTransaction({
                    signer: null,
                    mldsaSigner: null,
                    linkMLDSAPublicKeyToAddress: true,
                    refundTo: walletAddress,
                    maximumAllowedSatToSpend: 100_000n,
                    network: networks.testnet,
                });

                const approveObj = approveReceipt as unknown as Record<string, unknown>;
                if ('error' in approveObj) {
                    throw new Error(`Allowance transaction failed: ${String(approveObj['error'])}`);
                }

                // Brief wait for allowance TX to propagate
                await new Promise<void>((r) => setTimeout(r, 3000));
            }

            // Step 3: Generate trustless ed25519 keys + hash-lock
            setStep('creating');
            setStatusMessage('Generating trustless keys...');

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

            // Step 6: Simulate createSwap (swapContract already initialised above)
            setStatusMessage('Simulating swap creation...');

            const createSim = await swapContract.createSwap(
                hashLock,
                refundBlock,
                motoAmount,
                xmrAmount,
                xmrAddressHi,
                xmrAddressLo,
            );

            if ('error' in createSim) {
                throw new Error(`Swap simulation failed: ${String(createSim.error)}`);
            }

            // Step 7: Send transaction
            setStatusMessage('Waiting for wallet signature...');

            const createReceipt = await createSim.sendTransaction({
                signer: null,
                mldsaSigner: null,
                refundTo: walletAddress,
                maximumAllowedSatToSpend: 200_000n,
                network: networks.testnet,
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

            // Extract swapId from events
            const events = createSim.events ?? [];
            let swapId = 0n;
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

            // Store secret + view key locally
            saveLocalSwapSecret(swapId.toString(), secret, hashLockHex, aliceViewKey);
            void secretHexToBigint(secret);

            // Submit secret + view key to coordinator (non-fatal if it fails — SwapStatus retries)
            try {
                await submitSwapSecret(swapId.toString(), secret, aliceViewKey);
            } catch {
                console.warn('Failed to submit secret to coordinator — will retry on status page');
            }

            setTxResult({ txId, swapId });
            setStep('done');
            onSwapCreated(swapId);
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
                    Offer MOTO tokens in exchange for Monero. Trustless ed25519 keys are generated locally.
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
                            XMR amount you want to receive (12 decimal places).
                            The taker pays an additional 0.87% fee on top of this amount.
                        </p>
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

                    {/* Status */}
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
                                }}
                            />
                            {statusMessage}
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
                                Trustless keys saved locally. Do not clear localStorage until the swap is
                                complete.
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
                                    ? 'Approving...'
                                    : step === 'creating'
                                      ? 'Creating...'
                                      : 'Checking...'
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
