/**
 * App header — OP_NET branded with wallet connection and tab navigation.
 */
import React, { useState } from 'react';
import { useWalletConnect, SupportedWallets } from '@btc-vision/walletconnect';
import motoLogo from '../assets/motoswap-logo.png';
import xmrLogo from '../assets/monero-xmr-logo.png';
import { useBlockCountdown } from '../hooks/useBlockCountdown';
import { SettingsPanel } from './SettingsPanel';

type TabId = 'orderbook' | 'create' | 'myswaps' | 'recover' | 'docs';

interface HeaderProps {
    readonly activeTab: TabId;
    readonly onTabChange: (tab: TabId) => void;
}

/**
 * OP_NET-branded header with navigation tabs and wallet connector.
 */
function formatCountdown(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}

export function Header({ activeTab, onTabChange }: HeaderProps): React.ReactElement {
    const { publicKey, walletAddress, connectToWallet, disconnect } = useWalletConnect();
    const { blockNumber, secondsToNextBlock, waitingForBlock } = useBlockCountdown();
    const [settingsOpen, setSettingsOpen] = useState(false);

    const isConnected = publicKey !== null;

    const handleConnect = (): void => {
        connectToWallet(SupportedWallets.OP_WALLET);
    };

    const displayAddress =
        walletAddress && walletAddress.length > 12
            ? `${walletAddress.slice(0, 8)}...${walletAddress.slice(-6)}`
            : (walletAddress ?? '');

    const tabs: Array<{ id: TabId; label: string }> = [
        { id: 'orderbook', label: 'Order Book' },
        { id: 'create', label: 'Create Swap' },
        { id: 'myswaps', label: 'My Swaps' },
        { id: 'recover', label: 'Recover' },
        { id: 'docs', label: 'About' },
    ];

    return (
        <header
            style={{
                position: 'sticky',
                top: 0,
                zIndex: 'var(--z-header)' as React.CSSProperties['zIndex'],
                background: 'rgba(10, 10, 15, 0.95)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                borderBottom: '1px solid rgba(232, 115, 42, 0.12)',
            }}
        >
            <div
                style={{
                    maxWidth: '1200px',
                    margin: '0 auto',
                    padding: '0 24px',
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        height: '64px',
                        gap: '24px',
                    }}
                >
                    {/* MOTO-XMR Logos */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexShrink: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <img
                                src={motoLogo}
                                alt="MOTO"
                                width={34}
                                height={34}
                                style={{ borderRadius: '50%' }}
                            />
                            <img
                                src={xmrLogo}
                                alt="XMR"
                                width={34}
                                height={34}
                                style={{ borderRadius: '50%' }}
                            />
                        </div>

                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '3px 10px',
                                background: 'rgba(232, 115, 42, 0.08)',
                                border: '1px solid rgba(232, 115, 42, 0.2)',
                                borderRadius: '999px',
                            }}
                        >
                            <div
                                style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '50%',
                                    background: 'var(--color-status-open)',
                                    boxShadow: '0 0 6px var(--color-status-open)',
                                }}
                            />
                            <span
                                style={{
                                    fontSize: '0.7rem',
                                    fontWeight: 600,
                                    color: 'var(--color-text-secondary)',
                                    letterSpacing: '0.05em',
                                    textTransform: 'uppercase',
                                    fontFamily: 'var(--font-mono)',
                                }}
                            >
                                Mainnet
                            </span>
                        </div>
                    </div>

                    {/* Tabs */}
                    <nav
                        style={{
                            display: 'flex',
                            gap: '4px',
                            flex: 1,
                            justifyContent: 'center',
                        }}
                        role="tablist"
                        aria-label="Application navigation"
                    >
                        {tabs.map((tab) => (
                            <button
                                key={tab.id}
                                role="tab"
                                aria-selected={activeTab === tab.id}
                                onClick={() => onTabChange(tab.id)}
                                style={{
                                    padding: '6px 18px',
                                    borderRadius: '8px',
                                    border: 'none',
                                    background:
                                        activeTab === tab.id
                                            ? 'rgba(232, 115, 42, 0.12)'
                                            : 'transparent',
                                    color:
                                        activeTab === tab.id
                                            ? 'var(--color-orange-light)'
                                            : 'var(--color-text-secondary)',
                                    fontFamily: 'var(--font-display)',
                                    fontSize: '0.9rem',
                                    fontWeight: activeTab === tab.id ? 600 : 400,
                                    cursor: 'pointer',
                                    transition: 'all var(--transition-fast)',
                                    borderBottom:
                                        activeTab === tab.id
                                            ? '2px solid var(--color-orange)'
                                            : '2px solid transparent',
                                    minHeight: '36px',
                                    whiteSpace: 'nowrap',
                                }}
                                onMouseEnter={(e) => {
                                    if (activeTab !== tab.id) {
                                        (e.currentTarget as HTMLButtonElement).style.color =
                                            'var(--color-text-primary)';
                                    }
                                }}
                                onMouseLeave={(e) => {
                                    if (activeTab !== tab.id) {
                                        (e.currentTarget as HTMLButtonElement).style.color =
                                            'var(--color-text-secondary)';
                                    }
                                }}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </nav>

                    {/* Block Counter */}
                    {blockNumber !== null && (
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '4px 12px',
                                background: 'rgba(232, 115, 42, 0.06)',
                                border: '1px solid var(--color-border-default)',
                                borderRadius: 'var(--radius-md)',
                                fontFamily: 'var(--font-mono)',
                                fontSize: '0.75rem',
                                color: 'var(--color-text-secondary)',
                                flexShrink: 0,
                            }}
                        >
                            <span>Block</span>
                            <span style={{ color: 'var(--color-orange-light)' }}>
                                {blockNumber.toLocaleString()}
                            </span>
                            {secondsToNextBlock !== null && (
                                <span style={{ borderLeft: '1px solid var(--color-border-default)', paddingLeft: '8px' }}>
                                    {waitingForBlock
                                        ? 'any moment'
                                        : formatCountdown(secondsToNextBlock)}
                                </span>
                            )}
                        </div>
                    )}

                    {/* Settings */}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                        <button
                            onClick={() => setSettingsOpen(!settingsOpen)}
                            aria-label="Settings"
                            title="Settings"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: '36px',
                                height: '36px',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--color-border-default)',
                                background: settingsOpen ? 'rgba(232, 115, 42, 0.12)' : 'transparent',
                                cursor: 'pointer',
                                color: 'var(--color-text-secondary)',
                                transition: 'all var(--transition-fast)',
                            }}
                            onMouseEnter={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-accent)';
                            }}
                            onMouseLeave={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-text-secondary)';
                            }}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="3"/>
                                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
                            </svg>
                        </button>
                        {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
                    </div>

                    {/* Wallet */}
                    <div style={{ flexShrink: 0 }}>
                        {isConnected && walletAddress ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div
                                    style={{
                                        padding: '6px 14px',
                                        background: 'rgba(232, 115, 42, 0.06)',
                                        border: '1px solid var(--color-border-default)',
                                        borderRadius: 'var(--radius-md)',
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: '0.82rem',
                                        color: 'var(--color-text-secondary)',
                                        cursor: 'default',
                                    }}
                                    title={walletAddress}
                                >
                                    {displayAddress}
                                </div>
                                <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={disconnect}
                                    title="Disconnect wallet"
                                >
                                    Disconnect
                                </button>
                            </div>
                        ) : (
                            <button className="btn btn-primary btn-sm" onClick={handleConnect}>
                                Connect Wallet
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </header>
    );
}
