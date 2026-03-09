/**
 * Explorer links component — shown after every transaction.
 * Shows BOTH mempool and OPScan links as required.
 */
import React from 'react';

interface ExplorerLinksProps {
    readonly txId: string;
    readonly network?: 'testnet' | 'mainnet';
    readonly address?: string;
}

/**
 * Renders both Mempool and OPScan explorer links for a given transaction.
 */
export function ExplorerLinks({
    txId,
    network = 'testnet',
    address,
}: ExplorerLinksProps): React.ReactElement {
    const mempoolBase =
        network === 'testnet'
            ? 'https://mempool.opnet.org/testnet4/tx'
            : 'https://mempool.opnet.org/tx';
    const opscanNetwork = network === 'testnet' ? 'op_testnet' : 'op_mainnet';

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginTop: '12px',
            }}
        >
            <p
                style={{
                    fontSize: '0.8rem',
                    color: 'var(--color-text-secondary)',
                    marginBottom: '4px',
                }}
            >
                Transaction submitted. View on:
            </p>

            <a
                href={`${mempoolBase}/${txId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="explorer-link"
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                Mempool Explorer
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
            </a>

            {address && (
                <a
                    href={`https://opscan.org/accounts/${address}?network=${opscanNetwork}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="explorer-link"
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    </svg>
                    OPScan Explorer
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                </a>
            )}

            <p
                style={{
                    fontSize: '0.75rem',
                    color: 'var(--color-text-muted)',
                    marginTop: '4px',
                    fontFamily: 'var(--font-mono)',
                    wordBreak: 'break-all',
                }}
            >
                TX: {txId}
            </p>
        </div>
    );
}
