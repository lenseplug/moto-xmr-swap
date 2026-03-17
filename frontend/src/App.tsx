/**
 * Main application component for MOTO-XMR Atomic Swap.
 */
import React, { useState } from 'react';
import { Toaster } from 'sonner';
import { Header } from './components/Header';
import { OrderBook } from './components/OrderBook';
import { CreateSwap } from './components/CreateSwap';
import { TakeSwap } from './components/TakeSwap';
import { SwapStatus } from './components/SwapStatus';
import { MySwaps } from './components/MySwaps';
import { RecoverSwap } from './components/RecoverSwap';
import { Docs } from './components/Docs';
import { Footer } from './components/Footer';
import { SwapSessionProvider } from './contexts/SwapSessionContext';
import { SettingsProvider } from './contexts/SettingsContext';
import motoLogo from './assets/motoswap-logo.png';
import xmrLogo from './assets/monero-xmr-logo.png';

type TabId = 'orderbook' | 'create' | 'myswaps' | 'recover' | 'docs';

type ViewState =
    | { kind: 'tab'; tab: TabId }
    | { kind: 'take'; swapId: bigint }
    | { kind: 'status'; swapId: bigint };

/**
 * Root application component with tab-based navigation.
 */
export default function App(): React.ReactElement {
    const [view, setView] = useState<ViewState>({ kind: 'tab', tab: 'orderbook' });

    const handleRecovered = (swapId: bigint): void => {
        setView({ kind: 'status', swapId });
    };

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
        <SettingsProvider>
        <SwapSessionProvider>
        <>
            <Toaster
                position="top-right"
                theme="dark"
                richColors
                closeButton
                toastOptions={{
                    style: {
                        background: 'var(--color-bg-elevated)',
                        border: '1px solid var(--color-border-default)',
                        color: 'var(--color-text-primary)',
                        fontFamily: 'var(--font-display)',
                    },
                }}
            />

            {/* Watermark logos */}
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
                <img
                    src={motoLogo}
                    alt=""
                    style={{
                        position: 'absolute',
                        top: '15%',
                        left: '-5%',
                        width: '45vw',
                        maxWidth: '500px',
                        opacity: 0.03,
                        filter: 'blur(1px)',
                        transform: 'rotate(-15deg)',
                    }}
                />
                <img
                    src={xmrLogo}
                    alt=""
                    style={{
                        position: 'absolute',
                        bottom: '10%',
                        right: '-5%',
                        width: '40vw',
                        maxWidth: '450px',
                        opacity: 0.03,
                        filter: 'blur(1px)',
                        transform: 'rotate(12deg)',
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
                        gap: '16px',
                        marginBottom: '8px',
                    }}
                >
                    <img
                        src={motoLogo}
                        alt="MOTO"
                        width={52}
                        height={52}
                        style={{ borderRadius: '50%', boxShadow: '0 0 20px rgba(196, 86, 255, 0.3)' }}
                    />
                    <h1
                        style={{
                            fontSize: 'clamp(1.8rem, 4vw, 2.8rem)',
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            lineHeight: 1.2,
                        }}
                    >
                        <span style={{ color: '#c456ff' }}>MOTO</span>
                        <span style={{ color: 'var(--color-text-muted)', margin: '0 12px' }}>&gt;</span>
                        <span style={{ color: '#f26822' }}>XMR</span>
                        <span style={{ color: 'var(--color-text-primary)', marginLeft: '12px' }}>SWAP</span>
                    </h1>
                    <img
                        src={xmrLogo}
                        alt="XMR"
                        width={52}
                        height={52}
                        style={{ borderRadius: '50%', boxShadow: '0 0 20px rgba(242, 104, 34, 0.3)' }}
                    />
                </div>
                <p
                    style={{
                        color: 'var(--color-text-secondary)',
                        fontSize: '0.9rem',
                        marginTop: '8px',
                    }}
                >
                    Buy MOTO Anonymously
                </p>
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

                {view.kind === 'tab' && view.tab === 'recover' && (
                    <RecoverSwap onRecovered={handleRecovered} />
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

            <Footer />
        </>
        </SwapSessionProvider>
        </SettingsProvider>
    );
}
