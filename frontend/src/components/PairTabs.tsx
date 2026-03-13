/**
 * PairTabs — horizontal tab/filter bar for available trading pairs.
 * Shows "ALL" plus one tab per listed token (e.g., "MOTO/XMR", "TOKEN-B/XMR").
 */
import React, { useCallback } from 'react';
import type { ITokenRecord } from '../types/swap';

interface PairTabsProps {
    readonly tokens: ITokenRecord[];
    /** The currently active pair filter — null means "ALL". */
    readonly activePair: string | null;
    /** Called when the user selects a pair. null = ALL. */
    readonly onPairChange: (pair: string | null) => void;
}

/**
 * Compact horizontal filter bar for trading pairs.
 */
export function PairTabs({ tokens, activePair, onPairChange }: PairTabsProps): React.ReactElement {
    const handleClick = useCallback(
        (pair: string | null): void => {
            onPairChange(pair);
        },
        [onPairChange],
    );

    const tabStyle = (isActive: boolean): React.CSSProperties => ({
        padding: '5px 14px',
        borderRadius: '999px',
        border: '1px solid',
        borderColor: isActive ? 'var(--color-border-active)' : 'var(--color-border-subtle)',
        background: isActive ? 'rgba(232, 115, 42, 0.12)' : 'transparent',
        color: isActive ? 'var(--color-orange-light)' : 'var(--color-text-secondary)',
        fontFamily: 'var(--font-display)',
        fontSize: '0.78rem',
        fontWeight: isActive ? 600 : 400,
        cursor: 'pointer',
        transition: 'all var(--transition-fast)',
        whiteSpace: 'nowrap',
        letterSpacing: '0.03em',
        textTransform: 'uppercase',
        minHeight: '32px',
        display: 'inline-flex',
        alignItems: 'center',
    });

    return (
        <div
            style={{
                display: 'flex',
                gap: '6px',
                flexWrap: 'wrap',
                alignItems: 'center',
            }}
            role="tablist"
            aria-label="Pair filter"
        >
            <button
                role="tab"
                aria-selected={activePair === null}
                style={tabStyle(activePair === null)}
                onClick={() => handleClick(null)}
            >
                All Pairs
            </button>
            {tokens.map((token) => {
                const pair = `${token.symbol}-XMR`;
                const isActive = activePair === token.address;
                return (
                    <button
                        key={token.address}
                        role="tab"
                        aria-selected={isActive}
                        style={tabStyle(isActive)}
                        onClick={() => handleClick(token.address)}
                    >
                        {pair}
                    </button>
                );
            })}
        </div>
    );
}
