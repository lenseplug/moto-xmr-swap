/**
 * MnemonicInput — text input for entering 12 BIP39 words.
 * Provides real-time validation and paste support.
 */
import React, { useState, useCallback } from 'react';
import { validateSwapMnemonic } from '../utils/mnemonic';

interface MnemonicInputProps {
    readonly onSubmit: (mnemonic: string) => void;
    readonly submitLabel?: string;
}

export function MnemonicInput({ onSubmit, submitLabel = 'Recover' }: MnemonicInputProps): React.ReactElement {
    const [input, setInput] = useState('');

    const normalized = input.trim().toLowerCase().replace(/\s+/g, ' ');
    const wordCount = normalized ? normalized.split(' ').length : 0;
    const isValid = wordCount === 12 && validateSwapMnemonic(normalized);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
    }, []);

    const handleSubmit = useCallback(() => {
        if (isValid) {
            onSubmit(normalized);
        }
    }, [isValid, normalized, onSubmit]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey && isValid) {
            e.preventDefault();
            handleSubmit();
        }
    }, [isValid, handleSubmit]);

    return (
        <div>
            <textarea
                value={input}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder="Enter your 12 recovery words separated by spaces..."
                rows={3}
                className="input-field input-mono"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-gramm="false"
                data-gramm_editor="false"
                data-enable-grammarly="false"
                style={{
                    width: '100%',
                    resize: 'vertical',
                    minHeight: '80px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.88rem',
                }}
            />

            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: '8px',
                    marginBottom: '16px',
                }}
            >
                <span
                    style={{
                        fontSize: '0.75rem',
                        color: wordCount === 0
                            ? 'var(--color-text-muted)'
                            : isValid
                                ? 'var(--color-text-success)'
                                : 'var(--color-text-error)',
                        fontWeight: 500,
                    }}
                >
                    {wordCount === 0
                        ? 'Paste or type 12 words'
                        : isValid
                            ? 'Valid mnemonic'
                            : wordCount === 12
                                ? 'Invalid checksum'
                                : `${wordCount}/12 words`}
                </span>
                <span
                    style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        background: wordCount === 0
                            ? 'var(--color-border-subtle)'
                            : isValid
                                ? '#4ade80'
                                : '#ff5252',
                    }}
                />
            </div>

            <button
                className="btn btn-primary btn-lg"
                style={{ width: '100%' }}
                disabled={!isValid}
                onClick={handleSubmit}
            >
                {submitLabel}
            </button>
        </div>
    );
}
