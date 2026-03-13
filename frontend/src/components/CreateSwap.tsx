/**
 * CreateSwap form component -- OPNero branded.
 * Supports multiple OP-20 tokens via TokenSelector.
 * Two-panel "YOU PAY" / "YOU RECEIVE" design from opnerodex concept.
 */
import React, { useState, useCallback, useRef } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { networks } from '@btc-vision/bitcoin';
import { getSwapVaultContract, getTokenContract, parseTokenAmount, parseXmrAmount, splitXmrAddress, getProvider } from '../services/opnet';
import { generateTrustlessSecret, saveLocalSwapSecret, clearLocalSwapSecret, hashSecret } from '../utils/hashlock';
import { submitSwapSecret } from '../services/coordinator';
import { PrivacyBanner } from './PrivacyBanner';
import { ExplorerLinks } from './ExplorerLinks';
import { TokenSelector } from './TokenSelector';
import { useTokens } from '../hooks/useTokens';
import type { ITokenRecord } from '../types/swap';

const SWAP_VAULT_ADDRESS = import.meta.env.VITE_SWAP_VAULT_ADDRESS;
const BLOCKS_PER_HOUR = 6;
// Coordinator requires at least 50 blocks remaining when locking XMR.
// TODO(mainnet): Review and adjust for mainnet block times
const DEFAULT_TIMEOUT_BLOCKS = 80;

interface CreateSwapProps {
    readonly onSwapCreated: (swapId: bigint) => void;
}

interface FormState {
    tokenAmount: string;
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
 * Now supports any listed OP-20 token.
 */
export function CreateSwap({ onSwapCreated }: CreateSwapProps): React.ReactElement {
    const { publicKey, address: senderAddress, walletAddress } = useWalletConnect();
    const { tokens } = useTokens();

    const isConnected = publicKey !== null;

    // Selected token state -- default to first available token (MOTO)
    const [selectedToken, setSelectedToken] = useState<ITokenRecord | null>(null);

    // Resolve the effective token: selected or first from list
    const effectiveToken = selectedToken ?? tokens[0] ?? null;

    const [form, setForm] = useState<FormState>({
        tokenAmount: '',
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

    // Cancellation support
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

    const handleTokenSelect = useCallback((token: ITokenRecord): void => {
        setSelectedToken(token);
        setFormError(null);
    }, []);

    const validateForm = useCallback((): string | null => {
        if (effectiveToken === null) return 'Please select a token';

        const tokenAmt = parseTokenAmount(form.tokenAmount, effectiveToken.decimals);
        if (tokenAmt <= 0n) return `${effectiveToken.symbol} amount must be greater than zero`;

        const xmr = parseXmrAmount(form.xmrAmount);
        if (xmr <= 0n) return 'XMR amount must be greater than zero';
        if (xmr < 25_000_000_000n) return 'Minimum XMR amount is 0.025 XMR. Amounts below this may result in lost funds due to network fees exceeding the swap fee.';

        if (form.xmrAddress.trim().length < 10) return 'Please enter a valid XMR address';

        const blocks = parseInt(form.timeoutBlocks, 10);
        if (isNaN(blocks) || blocks < 60 || blocks > 10000)
            return 'Timeout must be between 60 and 10,000 blocks (coordinator needs at least 50 blocks to lock XMR safely)';

        return null;
    }, [form, effectiveToken]);

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

        if (!SWAP_VAULT_ADDRESS) {
            setFormError('Swap vault contract address not configured. Set VITE_SWAP_VAULT_ADDRESS.');
            return;
        }

        if (effectiveToken === null) {
            setFormError('No token selected');
            return;
        }

        const tokenAmount = parseTokenAmount(form.tokenAmount, effectiveToken.decimals);
        const xmrAmount = parseXmrAmount(form.xmrAmount);
        const timeoutBlocks = BigInt(parseInt(form.timeoutBlocks, 10));
        const tokenSymbol = effectiveToken.symbol;
        const tokenAddress = effectiveToken.address;

        setFormError(null);
        cancelledRef.current = false;

        try {
            // Step 1: Check existing allowance
            setStep('checking_allowance');
            setStatusMessage(`Checking ${tokenSymbol} allowance...`);

            const swapContract = getSwapVaultContract(SWAP_VAULT_ADDRESS, senderAddress);
            const vaultAddress = await swapContract.contractAddress;

            const tokenContract = getTokenContract(tokenAddress, senderAddress);
            const allowanceResult = await tokenContract.allowance(senderAddress, vaultAddress);
            if ('error' in allowanceResult) {
                throw new Error(`Allowance check failed: ${String(allowanceResult.error)}`);
            }

            const currentAllowance = allowanceResult.properties.remaining;

            // Step 2: Approve if needed
            if (currentAllowance < tokenAmount) {
                const bigApproval = 2n ** 128n - 1n;
                setStep('approving');
                setStatusMessage(`Approving ${tokenSymbol} for SwapVault (one-time)...`);

                const approveSim = await tokenContract.increaseAllowance(vaultAddress, bigApproval);
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

                // Wait for the approval to be confirmed on-chain
                setStatusMessage(`Approving ${tokenSymbol} -- waiting for block confirmation...`);
                const maxWaitMs = 10 * 60 * 1000;
                const pollMs = 5_000;
                const startTime = Date.now();
                let confirmed = false;

                while (Date.now() - startTime < maxWaitMs) {
                    await new Promise<void>((r) => setTimeout(r, pollMs));
                    const elapsed = Math.round((Date.now() - startTime) / 1000);
                    setStatusMessage(`Approving ${tokenSymbol} -- waiting for block confirmation (${elapsed}s)...`);
                    try {
                        const recheckResult = await tokenContract.allowance(senderAddress, vaultAddress);
                        if (!('error' in recheckResult) && recheckResult.properties.remaining >= tokenAmount) {
                            confirmed = true;
                            break;
                        }
                    } catch {
                        // RPC hiccup -- keep polling
                    }
                }

                if (!confirmed) {
                    throw new Error('Approval timed out -- the allowance TX may still be pending. Try again in a few minutes.');
                }
            }

            // Step 3: Generate ed25519 split keys + hash-lock
            setStep('creating');
            setStatusMessage('Generating swap keys...');

            const { secret, hashLock, hashLockHex, aliceViewKey } = await generateTrustlessSecret();

            const verifyHash = await hashSecret(secret);
            if (verifyHash !== hashLock) {
                throw new Error('BUG: SHA-256(secret) does not match hashLock -- key generation failed');
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
            const refundBlock = currentBlock + timeoutBlocks + 20n;

            // Step 6: Simulate createSwap with retry
            setStatusMessage('Simulating swap creation...');

            let createSim: Awaited<ReturnType<typeof swapContract.createSwap>> | null = null;
            const maxRetries = 36;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const simResult = await swapContract.createSwap(
                        tokenAddress,
                        hashLock,
                        refundBlock,
                        tokenAmount,
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
                        setStatusMessage(`Approving ${tokenSymbol} -- waiting for block confirmation (${attempt}/${maxRetries})...`);
                        await new Promise<void>((r) => setTimeout(r, 5_000));
                        continue;
                    }

                    throw new Error(`Swap simulation failed: ${errMsg}`);
                }
            }

            if (createSim === null) {
                throw new Error('Swap simulation failed: allowance not confirmed after retries. Try again in a few minutes.');
            }

            // Extract swapId from simulation
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

            console.log('[CreateSwap] Extracted swapId:', swapId.toString());

            // Save secret to localStorage BEFORE sending transaction
            const aliceXmrPayout = form.xmrAddress.trim();
            saveLocalSwapSecret(swapId.toString(), secret, hashLockHex, aliceViewKey, aliceXmrPayout);

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
                clearLocalSwapSecret(swapId.toString());
                throw new Error(`Swap transaction failed: ${String(receiptObj['error'])}`);
            }

            const txId =
                typeof receiptObj['result'] === 'string'
                    ? receiptObj['result']
                    : typeof receiptObj['txid'] === 'string'
                      ? receiptObj['txid']
                      : 'pending';

            // Submit secret to coordinator
            setStatusMessage('Registering swap secret with coordinator...');
            let secretSubmitted = false;
            for (let attempt = 0; attempt < 36; attempt++) {
                if (cancelledRef.current) break;
                const result = await submitSwapSecret(swapId.toString(), secret, aliceViewKey, aliceXmrPayout);
                if (result.ok) {
                    secretSubmitted = true;
                    break;
                }
                if (attempt < 35) {
                    await new Promise<void>((r) => setTimeout(r, 5_000));
                }
            }
            if (!secretSubmitted) {
                console.warn('[CreateSwap] Secret not confirmed by coordinator -- SwapStatus will retry');
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
        effectiveToken,
        validateForm,
        onSwapCreated,
    ]);

    const estimatedHours = Math.round(parseInt(form.timeoutBlocks || '0', 10) / BLOCKS_PER_HOUR);

    const isProcessing = step === 'checking_allowance' || step === 'approving' || step === 'creating';

    const tokenSymbol = effectiveToken?.symbol ?? 'TOKEN';

    const fieldLabel: React.CSSProperties = {
        display: 'block',
        fontSize: '0.75rem',
        fontWeight: 600,
        color: '#555566',
        marginBottom: '6px',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
    };

    // Shared panel style for YOU PAY / YOU RECEIVE
    const panelStyle: React.CSSProperties = {
        background: '#12121a',
        border: '1px solid #2a2a3a',
        borderRadius: '14px',
        padding: '20px',
    };

    return (
        <div style={{ maxWidth: '560px' }}>
            <div style={{ marginBottom: '24px' }}>
                <h2
                    style={{
                        fontSize: '1.35rem',
                        fontWeight: 700,
                        marginBottom: '6px',
                        color: '#ffffff',
                    }}
                >
                    Create Swap
                </h2>
                <p style={{ fontSize: '0.875rem', color: '#888899' }}>
                    Offer OP-20 tokens in exchange for Monero. Split ed25519 keys are generated locally.
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

                    {/* YOU PAY -- OP-20 Token Panel */}
                    <div style={panelStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#555566', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                                You Pay
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <div style={{
                                    width: '24px',
                                    height: '24px',
                                    borderRadius: '50%',
                                    background: 'linear-gradient(135deg, #ff6b00, #ff8533)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '0.55rem',
                                    fontWeight: 700,
                                    color: '#fff',
                                }}>
                                    OP
                                </div>
                                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#888899' }}>
                                    OP-20
                                </span>
                            </div>
                        </div>

                        {/* Token Selector */}
                        <div style={{ marginBottom: '12px' }}>
                            <TokenSelector
                                tokens={tokens}
                                selectedToken={effectiveToken}
                                onSelect={handleTokenSelect}
                                disabled={isProcessing || step === 'done'}
                            />
                        </div>

                        {/* Token Amount */}
                        <div>
                            <label htmlFor="token-amount" style={fieldLabel}>
                                {tokenSymbol} Amount
                            </label>
                            <input
                                id="token-amount"
                                type="text"
                                inputMode="decimal"
                                className="input-field tabular-nums"
                                placeholder="0.00"
                                value={form.tokenAmount}
                                onChange={handleFieldChange('tokenAmount')}
                                disabled={isProcessing || step === 'done'}
                                style={{ fontSize: '1.1rem', fontWeight: 600 }}
                            />
                            <p style={{ fontSize: '0.72rem', color: '#555566', marginTop: '4px' }}>
                                Amount of {tokenSymbol} tokens to lock in the swap vault
                            </p>
                        </div>
                    </div>

                    {/* Swap Direction Arrow */}
                    <div style={{ display: 'flex', justifyContent: 'center', margin: '-8px 0' }}>
                        <div
                            style={{
                                width: '40px',
                                height: '40px',
                                borderRadius: '12px',
                                background: '#1a1a24',
                                border: '2px solid #2a2a3a',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                zIndex: 2,
                            }}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6b00" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19" />
                                <polyline points="19 12 12 19 5 12" />
                            </svg>
                        </div>
                    </div>

                    {/* YOU RECEIVE -- XMR Panel */}
                    <div style={panelStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#555566', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                                You Receive
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                <div style={{
                                    width: '24px',
                                    height: '24px',
                                    borderRadius: '50%',
                                    background: 'linear-gradient(135deg, #f26822, #ff8533)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '0.55rem',
                                    fontWeight: 700,
                                    color: '#fff',
                                }}>
                                    M
                                </div>
                                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#888899' }}>
                                    XMR
                                </span>
                            </div>
                        </div>

                        {/* XMR Amount */}
                        <div style={{ marginBottom: '12px' }}>
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
                                style={{ fontSize: '1.1rem', fontWeight: 600 }}
                            />
                            <p style={{ fontSize: '0.72rem', color: '#555566', marginTop: '4px' }}>
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
                                    Amounts below 0.025 XMR may result in lost funds -- network fees can exceed the swap fee at this size.
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
                            <p style={{ fontSize: '0.72rem', color: '#555566', marginTop: '4px' }}>
                                Standard Monero address (starts with 4) or 128-char hex
                            </p>
                        </div>
                    </div>

                    {/* Timeout */}
                    <div style={{ padding: '0 4px' }}>
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
                        <p style={{ fontSize: '0.72rem', color: '#555566', marginTop: '4px' }}>
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
                                background: 'rgba(255, 107, 0, 0.06)',
                                border: '1px solid rgba(255, 107, 0, 0.12)',
                                borderRadius: 'var(--radius-md)',
                                fontSize: '0.875rem',
                                color: '#ff6b00',
                            }}
                        >
                            <div
                                style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '50%',
                                    background: '#ff6b00',
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
                                background: 'rgba(34, 197, 94, 0.06)',
                                border: '1px solid rgba(34, 197, 94, 0.2)',
                                borderRadius: 'var(--radius-md)',
                            }}
                        >
                            <p
                                style={{
                                    fontSize: '0.9rem',
                                    fontWeight: 600,
                                    color: '#22c55e',
                                    marginBottom: '4px',
                                }}
                            >
                                Swap Created
                            </p>
                            <p style={{ fontSize: '0.8rem', color: '#888899' }}>
                                Swap ID: <span className="font-mono">{txResult.swapId.toString()}</span>
                            </p>
                            <p
                                style={{
                                    fontSize: '0.75rem',
                                    color: '#555566',
                                    marginTop: '6px',
                                }}
                            >
                                Swap keys saved to browser storage. Safe to refresh -- do not clear browser data until the swap completes.
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
                            style={{
                                width: '100%',
                                background: '#ff6b00',
                                borderColor: '#ff6b00',
                                borderRadius: '12px',
                                fontSize: '1rem',
                                letterSpacing: '0.05em',
                            }}
                        >
                            {isProcessing
                                ? step === 'approving'
                                    ? `Approving ${tokenSymbol}...`
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
                                    tokenAmount: '',
                                    xmrAmount: '',
                                    xmrAddress: '',
                                    timeoutBlocks: String(DEFAULT_TIMEOUT_BLOCKS),
                                });
                            }}
                        >
                            Create Another Swap
                        </button>
                    )}

                    {/* Powered by OPNet badge near submit */}
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '4px' }}>
                        <span style={{ fontSize: '0.7rem', color: '#555566', letterSpacing: '0.04em' }}>
                            Powered by <span style={{ color: '#ff6b00', fontWeight: 600 }}>OPNet</span>
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
