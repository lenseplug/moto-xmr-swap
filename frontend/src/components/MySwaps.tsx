/**
 * MySwaps — shows swaps the current user is involved in.
 * Uses wallet address matching only (no localStorage).
 */
import React, { useState, useEffect } from 'react';
import { useWalletConnect } from '@btc-vision/walletconnect';
import { formatTokenAmount, formatXmrAmount } from '../services/opnet';
import { useSwaps } from '../hooks/useSwaps';
import { getAllCoordinatorStatuses } from '../services/coordinator';
import { SWAP_STATUS_LABELS } from '../types/swap';
import type { CoordinatorStatus } from '../types/swap';
import { SkeletonRow } from './SkeletonRow';

interface MySwapsProps {
    readonly onViewStatus: (swapId: bigint) => void;
}

export function MySwaps({ onViewStatus }: MySwapsProps): React.ReactElement {
    const { publicKey, address: senderAddress } = useWalletConnect();
    const isConnected = publicKey !== null;
    const { swaps, isLoading } = useSwaps();

    const myAddress = senderAddress?.toString().toLowerCase() ?? '';
    const [allCoordinatorStatuses, setAllCoordinatorStatuses] = useState<CoordinatorStatus[]>([]);
    const [pendingClaimStatuses, setPendingClaimStatuses] = useState<CoordinatorStatus[]>([]);

    useEffect(() => {
        if (!myAddress) return;
        let mounted = true;
        void getAllCoordinatorStatuses().then((statuses) => {
            if (!mounted) return;
            setAllCoordinatorStatuses(statuses);
            const pending = statuses.filter(
                (s) =>
                    (s.sweepStatus === 'pending' || s.sweepStatus?.startsWith('failed:')) &&
                    s.depositor?.toLowerCase() === myAddress,
            );
            setPendingClaimStatuses(pending);
        });
        return () => { mounted = false; };
    }, [swaps.length, myAddress]);

    // Swaps the user created — match by on-chain depositor address
    const myCreatedSwaps = swaps.filter((s) => {
        if (myAddress && s.depositor.toLowerCase() === myAddress) return true;
        return false;
    });

    // Swaps where the user is the taker (Bob) — match by on-chain counterparty address
    const myTakenSwaps = swaps.filter((s) => {
        const id = s.swapId.toString();
        if (myCreatedSwaps.some((c) => c.swapId.toString() === id)) return false;
        if (myAddress && s.counterparty.toLowerCase() === myAddress) return true;
        return false;
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
                    Swaps you have created or participated in. You will need your <strong>12 recovery words</strong> to interact with active swaps.
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

            {renderTable('Created by You', myCreatedSwaps, 'No swaps created by this wallet.')}
            {renderTable('Taken by You', myTakenSwaps, 'No swaps taken by this wallet.')}

            {myAddress && allCoordinatorStatuses.filter(
                (cs) => cs.depositor?.toLowerCase() === myAddress &&
                    !myCreatedSwaps.some((s) => s.swapId.toString() === cs.swapId),
            ).length > 0 && (
                <div>
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px', color: 'var(--color-text-secondary)', letterSpacing: '0.03em' }}>
                        Past Swaps
                    </h3>
                    <div className="glass-card" style={{ overflow: 'hidden', marginBottom: '24px' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                                    <th style={thStyle}>Swap ID</th>
                                    <th style={thStyle}>XMR</th>
                                    <th style={thStyle}>Status</th>
                                    <th style={thStyle}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {allCoordinatorStatuses
                                    .filter((cs) => cs.depositor?.toLowerCase() === myAddress &&
                                        !myCreatedSwaps.some((s) => s.swapId.toString() === cs.swapId))
                                    .map((cs) => (
                                        <tr key={cs.swapId}>
                                            <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>#{cs.swapId}</td>
                                            <td style={tdStyle}>
                                                {formatXmrAmount(BigInt(cs.xmrTotal ?? '0'))}{' '}
                                                <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>XMR</span>
                                            </td>
                                            <td style={tdStyle}>
                                                <span style={{ color: 'var(--color-text-secondary)', fontWeight: 500 }}>
                                                    {cs.step === 'complete' ? 'Completed' : cs.step === 'refunded' ? 'Refunded' : cs.message}
                                                </span>
                                            </td>
                                            <td style={{ ...tdStyle, textAlign: 'right' }}>
                                                <button className="btn btn-ghost btn-sm" onClick={() => onViewStatus(BigInt(cs.swapId))}>
                                                    View
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

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
