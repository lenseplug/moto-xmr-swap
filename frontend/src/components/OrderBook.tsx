/**
 * OrderBook component — displays active MOTO/XMR swaps.
 */
import React, { useState, useCallback } from 'react';
import { useSwaps, useBlockNumber } from '../hooks/useSwaps';
import { formatTokenAmount, formatXmrAmount } from '../services/opnet';
import { SWAP_STATUS_LABELS } from '../types/swap';
import type { SwapData, SortField, SortDirection } from '../types/swap';
import { SkeletonRow } from './SkeletonRow';

const MOTO_DECIMALS = 18;

interface OrderBookProps {
    readonly onTakeSwap: (swapId: bigint) => void;
}

function getStatusBadgeClass(status: bigint): string {
    switch (status) {
        case 0n: return 'badge badge-open';
        case 1n: return 'badge badge-taken';
        case 2n: return 'badge badge-claimed';
        case 3n: return 'badge badge-refunded';
        default: return 'badge';
    }
}

function computeRate(motoAmount: bigint, xmrAmount: bigint): string {
    if (motoAmount === 0n || xmrAmount === 0n) return '-';
    // Scale down before converting to Number to avoid precision loss on large bigints.
    // Retain 6 decimal places of precision in each after stripping 12 digits.
    const motoScaled = motoAmount / 10n ** 12n; // keeps 6 decimal places of 18
    const xmrScaled = xmrAmount / 10n ** 6n;    // keeps 6 decimal places of 12
    if (xmrScaled === 0n) return '-';
    const rate = Number(motoScaled) / Number(xmrScaled);
    return rate.toFixed(4);
}

type SortableSwap = SwapData & {
    motoFloat: number;
    xmrFloat: number;
    rate: number;
    blocksRemainingNum: bigint;
};

function enrichSwap(swap: SwapData, currentBlock: bigint | null): SortableSwap {
    const blocksRemainingNum =
        currentBlock !== null && swap.refundBlock > currentBlock
            ? swap.refundBlock - currentBlock
            : 0n;

    // Scale down before converting to Number to avoid precision loss.
    const motoScaled = swap.amount / 10n ** 12n;
    const xmrScaled = swap.xmrAmount / 10n ** 6n;

    return {
        ...swap,
        motoFloat: Number(motoScaled) / 1e6,
        xmrFloat: Number(xmrScaled) / 1e6,
        rate:
            swap.xmrAmount > 0n && swap.amount > 0n && xmrScaled > 0n
                ? Number(motoScaled) / Number(xmrScaled)
                : 0,
        blocksRemainingNum,
    };
}

function sortSwaps(
    swaps: SortableSwap[],
    field: SortField,
    direction: SortDirection,
): SortableSwap[] {
    return [...swaps].sort((a, b) => {
        let cmp = 0;
        switch (field) {
            case 'motoAmount':
                cmp = a.motoFloat - b.motoFloat;
                break;
            case 'xmrAmount':
                cmp = a.xmrFloat - b.xmrFloat;
                break;
            case 'rate':
                cmp = a.rate - b.rate;
                break;
            case 'blocksRemaining':
                cmp = Number(a.blocksRemainingNum - b.blocksRemainingNum);
                break;
        }
        return direction === 'asc' ? cmp : -cmp;
    });
}

/**
 * Sortable order book of active atomic swaps.
 */
export function OrderBook({ onTakeSwap }: OrderBookProps): React.ReactElement {
    const { swaps, isLoading, error, refresh, lastUpdated } = useSwaps();
    const currentBlock = useBlockNumber();

    const [sortField, setSortField] = useState<SortField>('blocksRemaining');
    const [sortDir, setSortDir] = useState<SortDirection>('asc');

    const handleSortClick = useCallback(
        (field: SortField): void => {
            if (sortField === field) {
                setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
            } else {
                setSortField(field);
                setSortDir('asc');
            }
        },
        [sortField],
    );

    const enriched = swaps.map((s) => enrichSwap(s, currentBlock));
    const sorted = sortSwaps(enriched, sortField, sortDir);

    const SortArrow = ({ field }: { field: SortField }): React.ReactElement => {
        if (sortField !== field)
            return <span style={{ color: 'var(--color-text-muted)' }}> ↕</span>;
        return (
            <span style={{ color: 'var(--color-text-accent)' }}>
                {sortDir === 'asc' ? ' ↑' : ' ↓'}
            </span>
        );
    };

    const thStyle: React.CSSProperties = {
        padding: '12px 16px',
        textAlign: 'left',
        fontSize: '0.75rem',
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        userSelect: 'none',
        fontFamily: 'var(--font-display)',
    };

    const tdStyle: React.CSSProperties = {
        padding: '14px 16px',
        fontSize: '0.9rem',
        color: 'var(--color-text-primary)',
        borderTop: '1px solid var(--color-border-subtle)',
        fontVariantNumeric: 'tabular-nums',
    };

    return (
        <div>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '20px',
                    flexWrap: 'wrap',
                    gap: '12px',
                }}
            >
                <div>
                    <h2
                        style={{
                            fontSize: '1.35rem',
                            fontWeight: 700,
                            color: 'var(--color-text-primary)',
                            marginBottom: '4px',
                        }}
                    >
                        Order Book
                    </h2>
                    <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                        {isLoading
                            ? 'Loading swaps...'
                            : `${sorted.length} active swap${sorted.length !== 1 ? 's' : ''}`}
                        {lastUpdated !== null && !isLoading && (
                            <span style={{ marginLeft: '8px', color: 'var(--color-text-muted)' }}>
                                Updated {lastUpdated.toLocaleTimeString()}
                            </span>
                        )}
                    </p>
                </div>

                <button className="btn btn-ghost btn-sm" onClick={() => void refresh()}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="23 4 23 10 17 10" />
                        <polyline points="1 20 1 14 7 14" />
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                    </svg>
                    Refresh
                </button>
            </div>

            {error !== null && (
                <div
                    style={{
                        padding: '14px 16px',
                        background: 'rgba(255, 82, 82, 0.08)',
                        border: '1px solid rgba(255, 82, 82, 0.25)',
                        borderRadius: 'var(--radius-md)',
                        color: 'var(--color-text-error)',
                        fontSize: '0.875rem',
                        marginBottom: '16px',
                    }}
                >
                    {error}
                </div>
            )}

            <div className="glass-card" style={{ overflow: 'hidden' }}>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                            <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                                <th
                                    style={thStyle}
                                    onClick={() => handleSortClick('motoAmount')}
                                >
                                    MOTO Amount
                                    <SortArrow field="motoAmount" />
                                </th>
                                <th
                                    style={thStyle}
                                    onClick={() => handleSortClick('xmrAmount')}
                                >
                                    XMR Amount
                                    <SortArrow field="xmrAmount" />
                                </th>
                                <th
                                    style={thStyle}
                                    onClick={() => handleSortClick('rate')}
                                >
                                    Rate (MOTO/XMR)
                                    <SortArrow field="rate" />
                                </th>
                                <th
                                    style={thStyle}
                                    onClick={() => handleSortClick('blocksRemaining')}
                                >
                                    Blocks Left
                                    <SortArrow field="blocksRemaining" />
                                </th>
                                <th style={{ ...thStyle, cursor: 'default' }}>Status</th>
                                <th style={{ ...thStyle, cursor: 'default' }}>Depositor</th>
                                <th style={{ ...thStyle, cursor: 'default' }}></th>
                            </tr>
                        </thead>
                        <tbody>
                            {isLoading
                                ? Array.from({ length: 4 }, (_, i) => (
                                      <SkeletonRow key={i} cols={7} />
                                  ))
                                : sorted.length === 0
                                  ? (
                                      <tr>
                                          <td
                                              colSpan={7}
                                              style={{
                                                  ...tdStyle,
                                                  textAlign: 'center',
                                                  padding: '48px 16px',
                                                  color: 'var(--color-text-muted)',
                                              }}
                                          >
                                              No active swaps. Be the first to create one.
                                          </td>
                                      </tr>
                                    )
                                  : sorted.map((swap) => {
                                        const statusLabel = SWAP_STATUS_LABELS[swap.status.toString()] ?? 'Unknown';
                                        const isOpen = swap.status === 0n;
                                        const isExpired =
                                            currentBlock !== null && swap.refundBlock <= currentBlock;
                                        const blocksLeft = swap.blocksRemainingNum;

                                        return (
                                            <tr
                                                key={swap.swapId.toString()}
                                                style={{
                                                    transition: 'background var(--transition-fast)',
                                                }}
                                                onMouseEnter={(e) => {
                                                    (e.currentTarget as HTMLTableRowElement).style.background =
                                                        'rgba(0, 229, 255, 0.03)';
                                                }}
                                                onMouseLeave={(e) => {
                                                    (e.currentTarget as HTMLTableRowElement).style.background =
                                                        'transparent';
                                                }}
                                            >
                                                <td style={tdStyle}>
                                                    <span
                                                        className="tabular-nums"
                                                        style={{ fontWeight: 600 }}
                                                    >
                                                        {formatTokenAmount(swap.amount, MOTO_DECIMALS)}
                                                    </span>
                                                    <span
                                                        style={{
                                                            fontSize: '0.75rem',
                                                            color: 'var(--color-text-muted)',
                                                            marginLeft: '4px',
                                                        }}
                                                    >
                                                        MOTO
                                                    </span>
                                                </td>

                                                <td style={tdStyle}>
                                                    <span
                                                        className="tabular-nums"
                                                        style={{ fontWeight: 600 }}
                                                    >
                                                        {formatXmrAmount(swap.xmrAmount)}
                                                    </span>
                                                    <span
                                                        style={{
                                                            fontSize: '0.75rem',
                                                            color: 'var(--color-text-muted)',
                                                            marginLeft: '4px',
                                                        }}
                                                    >
                                                        XMR
                                                    </span>
                                                </td>

                                                <td style={tdStyle}>
                                                    <span className="tabular-nums">
                                                        {computeRate(swap.amount, swap.xmrAmount)}
                                                    </span>
                                                </td>

                                                <td style={tdStyle}>
                                                    <span
                                                        className="tabular-nums"
                                                        style={{
                                                            color: isExpired
                                                                ? 'var(--color-text-error)'
                                                                : blocksLeft < 20n
                                                                  ? 'var(--color-text-warning)'
                                                                  : 'var(--color-text-primary)',
                                                        }}
                                                    >
                                                        {isExpired ? 'Expired' : blocksLeft.toString()}
                                                    </span>
                                                </td>

                                                <td style={tdStyle}>
                                                    <span className={getStatusBadgeClass(swap.status)}>
                                                        {statusLabel}
                                                    </span>
                                                </td>

                                                <td style={tdStyle}>
                                                    <span
                                                        className="truncate-address"
                                                        title={swap.depositor}
                                                    >
                                                        {swap.depositor.slice(0, 8)}...
                                                        {swap.depositor.slice(-6)}
                                                    </span>
                                                </td>

                                                <td style={{ ...tdStyle, textAlign: 'right' }}>
                                                    {isOpen && !isExpired && (
                                                        <button
                                                            className="btn btn-primary btn-sm"
                                                            onClick={() => onTakeSwap(swap.swapId)}
                                                        >
                                                            Take Swap
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        );
                                    })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
