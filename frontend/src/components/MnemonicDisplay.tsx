/**
 * MnemonicDisplay — shows 12 BIP39 words in a numbered 3x4 grid.
 * User must confirm they've written them down before proceeding.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';

interface MnemonicDisplayProps {
    readonly mnemonic: string;
    readonly onConfirm: () => void;
}

export function MnemonicDisplay({ mnemonic, onConfirm }: MnemonicDisplayProps): React.ReactElement {
    const words = mnemonic.split(' ');
    const [confirmed, setConfirmed] = useState(false);
    const [copied, setCopied] = useState(false);
    const clipboardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Clear clipboard timer on unmount to prevent mnemonic remaining in clipboard
    useEffect(() => {
        return () => {
            if (clipboardTimerRef.current) {
                clearTimeout(clipboardTimerRef.current);
            }
            // Clear clipboard on unmount (e.g., user clicks "Continue")
            if (copied) {
                void navigator.clipboard.writeText('');
            }
        };
    }, [copied]);

    const handleCopy = useCallback(() => {
        void navigator.clipboard.writeText(mnemonic).then(() => {
            setCopied(true);
            // Auto-clear clipboard after 60 seconds to prevent mnemonic leakage
            if (clipboardTimerRef.current) clearTimeout(clipboardTimerRef.current);
            clipboardTimerRef.current = setTimeout(() => {
                void navigator.clipboard.writeText('');
                setCopied(false);
                clipboardTimerRef.current = null;
            }, 60_000);
        });
    }, [mnemonic]);

    return (
        <div
            style={{
                padding: '24px',
                background: 'rgba(255, 215, 64, 0.04)',
                border: '1px solid rgba(255, 215, 64, 0.2)',
                borderRadius: 'var(--radius-md)',
            }}
        >
            <p
                style={{
                    fontSize: '0.9rem',
                    fontWeight: 700,
                    color: 'var(--color-text-warning)',
                    marginBottom: '4px',
                }}
            >
                Write Down These 12 Words
            </p>
            <p
                style={{
                    fontSize: '0.78rem',
                    color: 'var(--color-text-secondary)',
                    marginBottom: '8px',
                }}
            >
                This is your only way to recover this swap if you close or refresh this tab.
                Store these words safely offline — they will NOT be saved in your browser.
            </p>
            <p
                style={{
                    fontSize: '0.78rem',
                    color: 'var(--color-text-error)',
                    marginBottom: '16px',
                    fontWeight: 600,
                }}
            >
                If you lose these words, you may permanently lose access to your funds.
            </p>

            <div
                style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '8px',
                    marginBottom: '16px',
                }}
                data-gramm="false"
                data-gramm_editor="false"
                data-enable-grammarly="false"
                spellCheck={false}
            >
                {words.map((word, i) => (
                    <div
                        key={i}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '8px 12px',
                            background: 'rgba(0, 0, 0, 0.3)',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--color-border-subtle)',
                        }}
                    >
                        <span
                            style={{
                                fontSize: '0.7rem',
                                fontWeight: 600,
                                color: 'var(--color-text-muted)',
                                minWidth: '18px',
                                fontFamily: 'var(--font-mono)',
                            }}
                        >
                            {i + 1}.
                        </span>
                        <span
                            style={{
                                fontSize: '0.88rem',
                                fontWeight: 600,
                                color: 'var(--color-text-primary)',
                                fontFamily: 'var(--font-mono)',
                            }}
                        >
                            {word}
                        </span>
                    </div>
                ))}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={handleCopy}
                    style={{ fontSize: '0.78rem' }}
                >
                    {copied ? 'Copied!' : 'Copy to clipboard'}
                </button>
                {copied && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--color-text-warning)' }}>
                        Clear your clipboard after pasting to a secure location.
                    </span>
                )}
            </div>

            <label
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    cursor: 'pointer',
                    marginBottom: '16px',
                }}
            >
                <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    style={{ width: '18px', height: '18px', accentColor: 'var(--color-orange)' }}
                />
                <span style={{ fontSize: '0.85rem', color: 'var(--color-text-primary)', fontWeight: 500 }}>
                    I have written down these 12 words
                </span>
            </label>

            <button
                className="btn btn-primary btn-lg"
                style={{ width: '100%' }}
                disabled={!confirmed}
                onClick={onConfirm}
            >
                Continue
            </button>
        </div>
    );
}
