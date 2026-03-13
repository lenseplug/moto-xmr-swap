/**
 * TokenSelector — dropdown for selecting a token in multi-token swaps.
 * Shows token name, symbol, and optionally the user's balance.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { ITokenRecord } from '../types/swap';

interface TokenSelectorProps {
    readonly tokens: ITokenRecord[];
    readonly selectedToken: ITokenRecord | null;
    readonly onSelect: (token: ITokenRecord) => void;
    /** Optional: balance map keyed by token address. */
    readonly balances?: ReadonlyMap<string, string>;
    readonly disabled?: boolean;
}

/**
 * Dropdown token selector with dark OPNero styling.
 */
export function TokenSelector({
    tokens,
    selectedToken,
    onSelect,
    balances,
    disabled = false,
}: TokenSelectorProps): React.ReactElement {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent): void => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleToggle = useCallback((): void => {
        if (!disabled) setIsOpen((prev) => !prev);
    }, [disabled]);

    const handleSelect = useCallback(
        (token: ITokenRecord): void => {
            onSelect(token);
            setIsOpen(false);
        },
        [onSelect],
    );

    const buttonStyle: React.CSSProperties = {
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        background: 'rgba(0, 0, 0, 0.3)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: 'var(--radius-md)',
        color: selectedToken ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
        fontFamily: 'var(--font-display)',
        fontSize: '0.95rem',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'border-color var(--transition-fast)',
        minHeight: '44px',
    };

    const dropdownStyle: React.CSSProperties = {
        position: 'absolute',
        top: '100%',
        left: 0,
        right: 0,
        marginTop: '4px',
        background: 'var(--color-bg-elevated)',
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-card)',
        zIndex: 50,
        maxHeight: '240px',
        overflowY: 'auto',
    };

    const optionStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        cursor: 'pointer',
        transition: 'background var(--transition-fast)',
        borderBottom: '1px solid var(--color-border-subtle)',
    };

    return (
        <div ref={containerRef} style={{ position: 'relative' }}>
            <button
                type="button"
                style={buttonStyle}
                onClick={handleToggle}
                aria-expanded={isOpen}
                aria-haspopup="listbox"
            >
                <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {selectedToken ? (
                        <>
                            <span
                                style={{
                                    width: '24px',
                                    height: '24px',
                                    borderRadius: '50%',
                                    background: 'linear-gradient(135deg, var(--color-orange), var(--color-purple))',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '0.65rem',
                                    fontWeight: 700,
                                    color: '#fff',
                                    flexShrink: 0,
                                }}
                            >
                                {selectedToken.symbol.slice(0, 2)}
                            </span>
                            <span style={{ fontWeight: 600 }}>{selectedToken.symbol}</span>
                            <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
                                {selectedToken.name}
                            </span>
                        </>
                    ) : (
                        'Select token...'
                    )}
                </span>
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{
                        transform: isOpen ? 'rotate(180deg)' : 'none',
                        transition: 'transform var(--transition-fast)',
                    }}
                >
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>

            {isOpen && (
                <div style={dropdownStyle} role="listbox">
                    {tokens.length === 0 ? (
                        <div
                            style={{
                                padding: '16px',
                                textAlign: 'center',
                                color: 'var(--color-text-muted)',
                                fontSize: '0.85rem',
                            }}
                        >
                            No tokens available
                        </div>
                    ) : (
                        tokens.map((token) => {
                            const isSelected =
                                selectedToken !== null &&
                                token.address.toLowerCase() === selectedToken.address.toLowerCase();
                            const balance = balances?.get(token.address.toLowerCase());
                            return (
                                <div
                                    key={token.address}
                                    role="option"
                                    aria-selected={isSelected}
                                    style={{
                                        ...optionStyle,
                                        background: isSelected ? 'rgba(232, 115, 42, 0.08)' : 'transparent',
                                    }}
                                    onClick={() => handleSelect(token)}
                                    onMouseEnter={(e) => {
                                        if (!isSelected) {
                                            (e.currentTarget as HTMLDivElement).style.background =
                                                'rgba(255, 255, 255, 0.04)';
                                        }
                                    }}
                                    onMouseLeave={(e) => {
                                        if (!isSelected) {
                                            (e.currentTarget as HTMLDivElement).style.background =
                                                'transparent';
                                        }
                                    }}
                                >
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <span
                                            style={{
                                                width: '28px',
                                                height: '28px',
                                                borderRadius: '50%',
                                                background: 'linear-gradient(135deg, var(--color-orange), var(--color-purple))',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                fontSize: '0.7rem',
                                                fontWeight: 700,
                                                color: '#fff',
                                                flexShrink: 0,
                                            }}
                                        >
                                            {token.symbol.slice(0, 2)}
                                        </span>
                                        <span>
                                            <span
                                                style={{
                                                    display: 'block',
                                                    fontWeight: 600,
                                                    fontSize: '0.9rem',
                                                    color: 'var(--color-text-primary)',
                                                }}
                                            >
                                                {token.symbol}
                                            </span>
                                            <span
                                                style={{
                                                    fontSize: '0.75rem',
                                                    color: 'var(--color-text-muted)',
                                                }}
                                            >
                                                {token.name}
                                            </span>
                                        </span>
                                    </span>
                                    {balance !== undefined && (
                                        <span
                                            style={{
                                                fontSize: '0.82rem',
                                                color: 'var(--color-text-secondary)',
                                                fontFamily: 'var(--font-mono)',
                                                fontVariantNumeric: 'tabular-nums',
                                            }}
                                        >
                                            {balance}
                                        </span>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            )}
        </div>
    );
}
