/**
 * MySwaps — shows swaps the current user is involved in.
 * Reads all local secrets and shows their status.
 */
import React, { useState, useEffect } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { loadLocalSwapSecrets, getBobKeys } from '../utils/hashlock';
import { formatTokenAmount, formatXmrAmount } from '../services/opnet';
import { useSwaps } from '../hooks/useSwaps';
import { getAllCoordinatorStatuses } from '../services/coordinator';
import { SWAP_STATUS_LABELS } from '../types/swap';
import type { CoordinatorStatus } from '../types/swap';
import { SkeletonRow } from './SkeletonRow';

interface MySwapsProps {
    readonly onViewStatus: (swapId: bigint) => void;
}

/**
 * Shows active swaps the user created (from localStorage) and swaps they've taken.
 */
export function MySwaps({ onViewStatus }: MySwapsProps): React.ReactElement {
    const { publicKey, address: senderAddress } = useWalletConnect();
    const isConnected = publicKey !== null;
    const { swaps, isLoading } = useSwaps();

    const localSecrets = loadLocalSwapSecrets();
    const localSwapIds = new Set(localSecrets.map((s) => s.swapId));

    // Fetch coordinator swaps with pending XMR claims (only for Alice = depositor)
    const myAddress = senderAddress?.toString().toLowerCase() ?? '';
    const [pendingClaimStatuses, setPendingClaimStatuses] = useState<CoordinatorStatus[]>([]);

    useEffect(() => {
        if (!myAddress) return;
        let mounted = true;
        void getAllCoordinatorStatuses().then((statuses) => {
            if (!mounted) return;
            const pending = statuses.filter(
                (s) =>
                    (s.sweepStatus === 'pending' || s.sweepStatus?.startsWith('failed:')) &&
                    s.depositor?.toLowerCase() === myAddress,
            );
            setPendingClaimStatuses(pending);
        });
        return () => { mounted = false; };
    }, [swaps.length, myAddress]); // re-check when swap list or wallet changes

    // Swaps the user created (have a local secret for)
    const myCreatedSwaps = swaps.filter((s) => localSwapIds.has(s.swapId.toString()));

    // Swaps where the user is the taker (Bob) — identified by stored Bob keys in sessionStorage
    const myTakenSwaps = swaps.filter((s) => {
        if (localSwapIds.has(s.swapId.toString())) return false; // skip own swaps
        const bobKeys = getBobKeys(s.swapId.toString());
        return bobKeys !== null;
    });

    const tdStyle: React.CSSProperties = {
        padding: '14px 16px',
        fontSize: '0.88rem',
        color: 'var(--color-text-primary)',
        borderTop: '1px solid var(--color-border-subtle)',
        fontVariantNumeric: 'tabular-nums',
    };

    const thStyle: React.CSSProperties = {
        padding: '12px 16px',
        textAlign: 'left',
        fontSize: '0.72rem',
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        fontFamily: 'var(--font-display)',
    };

    const renderTable = (
        title: string,
        rows: typeof swaps,
        emptyMsg: string,
    ): React.ReactElement => (
        <div>
            <h3
                style={{
                    fontSize: '1rem',
                    fontWeight: 600,
                    marginBottom: '12px',
                    color: 'var(--color-text-secondary)',
                    letterSpacing: '0.03em',
                }}
            >
                {title}
            </h3>
            <div className="glass-card" style={{ overflow: 'hidden', marginBottom: '24px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                            <th style={thStyle}>Swap ID</th>
                            <th style={thStyle}>MOTO</th>
                            <th style={thStyle}>XMR</th>
                            <th style={thStyle}>Status</th>
                            <th style={thStyle}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {isLoading ? (
                            Array.from({ length: 2 }, (_, i) => <SkeletonRow key={i} cols={5} />)
                        ) : rows.length === 0 ? (
                            <tr>
                                <td
                                    colSpan={5}
                                    style={{
                                        ...tdStyle,
                                        textAlign: 'center',
                                        padding: '32px 16px',
                                        color: 'var(--color-text-muted)',
                                    }}
                                >
                                    {emptyMsg}
                                </td>
                            </tr>
                        ) : (
                            rows.map((swap) => (
                                <tr key={swap.swapId.toString()}>
                                    <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                                        #{swap.swapId.toString()}
                                    </td>
                                    <td style={tdStyle}>
                                        {formatTokenAmount(swap.amount)}{' '}
                                        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>MOTO</span>
                                    </td>
                                    <td style={tdStyle}>
                                        {formatXmrAmount(swap.xmrAmount)}{' '}
                                        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>XMR</span>
                                    </td>
                                    <td style={tdStyle}>
                                        <span
                                            style={{
                                                color:
                                                    swap.status === 0n
                                                        ? 'var(--color-status-open)'
                                                        : swap.status === 1n
                                                          ? 'var(--color-status-taken)'
                                                          : swap.status === 2n
                                                            ? 'var(--color-status-claimed)'
                                                            : 'var(--color-status-refunded)',
                                                fontWeight: 500,
                                            }}
                                        >
                                            {SWAP_STATUS_LABELS[swap.status.toString()] ?? 'Unknown'}
                                        </span>
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                                        <button
                                            className="btn btn-ghost btn-sm"
                                            onClick={() => onViewStatus(swap.swapId)}
                                        >
                                            View
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );

    return (
        <div>
            <div style={{ marginBottom: '24px' }}>
                <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '6px' }}>
                    My Swaps
                </h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                    Swaps you have created or participated in.
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
                    Connect your wallet to view your swaps.
                </div>
            )}

            {renderTable('Created by You', myCreatedSwaps, 'No swaps created from this browser session.')}
            {renderTable('Taken by You', myTakenSwaps, 'No swaps taken on this account.')}

            {/* Completed swaps awaiting XMR claim */}
            {pendingClaimStatuses.length > 0 && (
                <div>
                    <h3
                        style={{
                            fontSize: '1rem',
                            fontWeight: 600,
                            marginBottom: '12px',
                            color: 'var(--color-text-warning)',
                            letterSpacing: '0.03em',
                        }}
                    >
                        XMR Sweeps In Progress
                    </h3>
                    <div className="glass-card" style={{ overflow: 'hidden', marginBottom: '24px' }}>
                        {pendingClaimStatuses.map((status) => (
                            <div
                                key={status.swapId}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '14px 16px',
                                    borderBottom: '1px solid var(--color-border-subtle)',
                                }}
                            >
                                <div>
                                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}>
                                        Swap #{status.swapId}
                                    </span>
                                    <span
                                        style={{
                                            marginLeft: '12px',
                                            fontSize: '0.75rem',
                                            color: 'var(--color-text-warning)',
                                            fontWeight: 600,
                                        }}
                                    >
                                        {status.sweepStatus === 'pending' ? 'Sweeping...' : 'Sweep failed — auto-retrying'}
                                    </span>
                                </div>
                                <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => onViewStatus(BigInt(status.swapId))}
                                >
                                    View
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

        </div>
    );
}
