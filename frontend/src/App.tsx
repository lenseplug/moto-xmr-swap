/**
 * Main application component for OPNero — OP-20/XMR Private DEX.
 */
import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { OrderBook } from './components/OrderBook';
import { CreateSwap } from './components/CreateSwap';
import { TakeSwap } from './components/TakeSwap';
import { SwapStatus } from './components/SwapStatus';
import { MySwaps } from './components/MySwaps';
import { Docs } from './components/Docs';

type TabId = 'orderbook' | 'create' | 'myswaps' | 'docs';

type ViewState =
    | { kind: 'tab'; tab: TabId }
    | { kind: 'take'; swapId: bigint }
    | { kind: 'status'; swapId: bigint };

/**
 * Root application component with tab-based navigation.
 */
export default function App(): React.ReactElement {
    const [view, setView] = useState<ViewState>({ kind: 'tab', tab: 'orderbook' });

    // Recover in-flight swap takes on page refresh
    useEffect(() => {
        try {
            // Check for Bob's claim tokens (taker side)
            const claimRaw = localStorage.getItem('moto_xmr_claim_tokens');
            if (claimRaw) {
                const tokens = JSON.parse(claimRaw) as Record<string, string>;
                const firstSwapId = Object.keys(tokens)[0];
                if (firstSwapId) {
                    setView({ kind: 'status', swapId: BigInt(firstSwapId) });
                    return;
                }
            }
            // Check for Alice's secrets (creator side)
            const secretRaw = localStorage.getItem('moto_xmr_swap_secrets');
            if (secretRaw) {
                const secrets = JSON.parse(secretRaw) as Array<{ swapId: string }>;
                if (secrets.length > 0) {
                    setView({ kind: 'status', swapId: BigInt(secrets[0].swapId) });
                }
            }
        } catch {
            // localStorage parse error — ignore
        }
    }, []);

    const activeTab: TabId =
        view.kind === 'tab' ? view.tab : view.kind === 'take' ? 'orderbook' : 'myswaps';

    const handleTabChange = (tab: TabId): void => {
        setView({ kind: 'tab', tab });
    };

    const handleTakeSwap = (swapId: bigint): void => {
        setView({ kind: 'take', swapId });
    };

    const handleSwapCreated = (swapId: bigint): void => {
        setView({ kind: 'status', swapId });
    };

    const handleSwapTaken = (swapId: bigint): void => {
        setView({ kind: 'status', swapId });
    };

    const handleViewStatus = (swapId: bigint): void => {
        setView({ kind: 'status', swapId });
    };

    const handleBack = (): void => {
        if (view.kind === 'take') {
            setView({ kind: 'tab', tab: 'orderbook' });
        } else if (view.kind === 'status') {
            setView({ kind: 'tab', tab: 'myswaps' });
        } else {
            setView({ kind: 'tab', tab: 'orderbook' });
        }
    };

    return (
        <>
            {/* Subtle background glow elements */}
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    pointerEvents: 'none',
                    zIndex: 0,
                    overflow: 'hidden',
                }}
                aria-hidden="true"
            >
                {/* Top-center subtle orange glow */}
                <div
                    style={{
                        position: 'absolute',
                        top: '-20%',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        width: '60vw',
                        height: '40vh',
                        background: 'radial-gradient(ellipse, rgba(255, 107, 0, 0.04) 0%, transparent 70%)',
                    }}
                />
                {/* Bottom-right violet glow */}
                <div
                    style={{
                        position: 'absolute',
                        bottom: '-10%',
                        right: '-10%',
                        width: '50vw',
                        height: '50vh',
                        background: 'radial-gradient(ellipse, rgba(124, 58, 237, 0.03) 0%, transparent 70%)',
                    }}
                />
            </div>

            <Header activeTab={activeTab} onTabChange={handleTabChange} />

            {/* Title Banner */}
            <div
                style={{
                    textAlign: 'center',
                    padding: '40px 24px 20px',
                    position: 'relative',
                    zIndex: 1,
                }}
            >
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '4px',
                        marginBottom: '8px',
                    }}
                >
                    <h1
                        style={{
                            fontSize: 'clamp(2rem, 5vw, 3.2rem)',
                            fontWeight: 700,
                            letterSpacing: '0.03em',
                            lineHeight: 1.2,
                            fontFamily: 'var(--font-display)',
                        }}
                    >
                        <span style={{ color: '#ff6b00' }}>OP</span>
                        <span style={{ color: '#ffffff' }}>Nero</span>
                    </h1>
                </div>
                <p
                    style={{
                        color: '#888899',
                        fontSize: '0.95rem',
                        marginTop: '4px',
                        letterSpacing: '0.06em',
                        fontWeight: 400,
                    }}
                >
                    Private cross-chain swaps between OP-20 tokens and Monero
                </p>

                {/* Stats strip */}
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '24px',
                        marginTop: '16px',
                    }}
                >
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '6px 16px',
                            background: 'rgba(255, 107, 0, 0.04)',
                            border: '1px solid rgba(255, 107, 0, 0.10)',
                            borderRadius: '999px',
                        }}
                    >
                        <span style={{ fontSize: '0.75rem', color: '#555566', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.06em' }}>
                            Powered by
                        </span>
                        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#ff6b00' }}>
                            OPNet
                        </span>
                    </div>
                </div>
            </div>

            <main
                style={{
                    flex: 1,
                    maxWidth: '1200px',
                    width: '100%',
                    margin: '0 auto',
                    padding: '12px 24px 64px',
                    position: 'relative',
                    zIndex: 1,
                }}
            >
                {view.kind === 'tab' && view.tab === 'orderbook' && (
                    <OrderBook onTakeSwap={handleTakeSwap} />
                )}

                {view.kind === 'tab' && view.tab === 'create' && (
                    <CreateSwap onSwapCreated={handleSwapCreated} />
                )}

                {view.kind === 'tab' && view.tab === 'myswaps' && (
                    <MySwaps onViewStatus={handleViewStatus} />
                )}

                {view.kind === 'tab' && view.tab === 'docs' && <Docs />}

                {view.kind === 'take' && (
                    <TakeSwap
                        swapId={view.swapId}
                        onBack={handleBack}
                        onTaken={handleSwapTaken}
                    />
                )}

                {view.kind === 'status' && (
                    <SwapStatus swapId={view.swapId} onBack={handleBack} />
                )}
            </main>

            {/* Footer */}
            <footer
                style={{
                    borderTop: '1px solid rgba(255, 107, 0, 0.06)',
                    padding: '20px 24px',
                    position: 'relative',
                    zIndex: 1,
                }}
            >
                <div
                    style={{
                        maxWidth: '1200px',
                        margin: '0 auto',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '12px',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                        <a
                            href="#"
                            onClick={(e) => { e.preventDefault(); }}
                            style={{
                                fontSize: '0.8rem',
                                color: '#555566',
                                textDecoration: 'none',
                                transition: 'color 150ms ease',
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#ff6b00'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#555566'; }}
                        >
                            Docs
                        </a>
                        <a
                            href="https://github.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                                fontSize: '0.8rem',
                                color: '#555566',
                                textDecoration: 'none',
                                transition: 'color 150ms ease',
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#ff6b00'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#555566'; }}
                        >
                            GitHub
                        </a>
                        <a
                            href="#"
                            onClick={(e) => { e.preventDefault(); }}
                            style={{
                                fontSize: '0.8rem',
                                color: '#555566',
                                textDecoration: 'none',
                                transition: 'color 150ms ease',
                            }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#ff6b00'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#555566'; }}
                        >
                            Community
                        </a>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <span style={{ fontSize: '0.75rem', color: '#555566' }}>
                            Built with{' '}
                            <span style={{ color: '#ff6b00', fontWeight: 600 }}>OPNet</span>
                        </span>
                        <span style={{ color: '#2a2a3a' }}>|</span>
                        <span
                            style={{
                                fontSize: '0.75rem',
                                fontFamily: 'var(--font-mono)',
                                color: '#555566',
                                fontWeight: 500,
                            }}
                        >
                            opnero.xyz
                        </span>
                    </div>
                </div>
            </footer>
        </>
    );
}
