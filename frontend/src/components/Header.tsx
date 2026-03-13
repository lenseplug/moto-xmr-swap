/**
 * OPNero header -- branded navigation with wallet connection.
 */
import React from 'react';
import { useWalletConnect, SupportedWallets } from '@btc-vision/walletconnect';

type TabId = 'orderbook' | 'create' | 'myswaps' | 'docs';

interface HeaderProps {
    readonly activeTab: TabId;
    readonly onTabChange: (tab: TabId) => void;
}

/**
 * OPNero-branded header with navigation tabs and wallet connector.
 */
export function Header({ activeTab, onTabChange }: HeaderProps): React.ReactElement {
    const { publicKey, walletAddress, connectToWallet, disconnect } = useWalletConnect();

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
                borderBottom: '1px solid rgba(255, 107, 0, 0.08)',
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
                    {/* OPNero Logo + Branding */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexShrink: 0 }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: '2px' }}>
                                <span
                                    style={{
                                        fontSize: '1.4rem',
                                        fontWeight: 700,
                                        color: '#ff6b00',
                                        letterSpacing: '0.02em',
                                        fontFamily: 'var(--font-display)',
                                    }}
                                >
                                    OP
                                </span>
                                <span
                                    style={{
                                        fontSize: '1.4rem',
                                        fontWeight: 700,
                                        color: '#ffffff',
                                        letterSpacing: '0.02em',
                                        fontFamily: 'var(--font-display)',
                                    }}
                                >
                                    Nero
                                </span>
                            </div>
                            <span
                                style={{
                                    fontSize: '0.6rem',
                                    fontWeight: 500,
                                    color: '#555566',
                                    letterSpacing: '0.12em',
                                    textTransform: 'uppercase',
                                    marginTop: '-2px',
                                    fontFamily: 'var(--font-mono)',
                                }}
                            >
                                OP-20 / XMR DEX
                            </span>
                        </div>

                        {/* Network Badge */}
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '3px 10px',
                                background: 'rgba(255, 107, 0, 0.06)',
                                border: '1px solid rgba(255, 107, 0, 0.15)',
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
                                Testnet
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
                                            ? 'rgba(255, 107, 0, 0.10)'
                                            : 'transparent',
                                    color:
                                        activeTab === tab.id
                                            ? '#ff6b00'
                                            : 'var(--color-text-secondary)',
                                    fontFamily: 'var(--font-display)',
                                    fontSize: '0.9rem',
                                    fontWeight: activeTab === tab.id ? 600 : 400,
                                    cursor: 'pointer',
                                    transition: 'all var(--transition-fast)',
                                    borderBottom:
                                        activeTab === tab.id
                                            ? '2px solid #ff6b00'
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

                    {/* Right: opnero.xyz badge + Wallet */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                        {/* opnero.xyz badge */}
                        <span
                            style={{
                                fontSize: '0.7rem',
                                fontWeight: 500,
                                color: '#555566',
                                fontFamily: 'var(--font-mono)',
                                letterSpacing: '0.04em',
                                padding: '2px 8px',
                                border: '1px solid #2a2a3a',
                                borderRadius: '6px',
                                display: 'none', // hidden on small screens via inline
                            }}
                            className="opnero-badge"
                        >
                            opnero.xyz
                        </span>

                        {isConnected && walletAddress ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <div
                                    style={{
                                        padding: '6px 14px',
                                        background: 'rgba(255, 107, 0, 0.05)',
                                        border: '1px solid #2a2a3a',
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
