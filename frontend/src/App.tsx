/**
 * Main application component for MOTO-XMR Atomic Swap.
 */
import React, { useState } from 'react';
import { Header } from './components/Header';
import { OrderBook } from './components/OrderBook';
import { CreateSwap } from './components/CreateSwap';
import { TakeSwap } from './components/TakeSwap';
import { SwapStatus } from './components/SwapStatus';
import { MySwaps } from './components/MySwaps';

type TabId = 'orderbook' | 'create' | 'myswaps';

type ViewState =
    | { kind: 'tab'; tab: TabId }
    | { kind: 'take'; swapId: bigint }
    | { kind: 'status'; swapId: bigint };

/**
 * Root application component with tab-based navigation.
 */
export default function App(): React.ReactElement {
    const [view, setView] = useState<ViewState>({ kind: 'tab', tab: 'orderbook' });

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
            <Header activeTab={activeTab} onTabChange={handleTabChange} />

            {/* Title Banner */}
            <div
                style={{
                    textAlign: 'center',
                    padding: '40px 24px 20px',
                }}
            >
                <h1
                    style={{
                        fontSize: 'clamp(1.8rem, 4vw, 2.8rem)',
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        lineHeight: 1.2,
                    }}
                >
                    <span style={{ color: 'var(--color-purple-light)' }}>MOTO</span>
                    <span style={{ color: 'var(--color-text-muted)', margin: '0 12px' }}>&gt;</span>
                    <span style={{ color: 'var(--color-orange)' }}>XMR</span>
                    <span style={{ color: 'var(--color-text-primary)', marginLeft: '12px' }}>SWAP</span>
                </h1>
                <p
                    style={{
                        color: 'var(--color-text-secondary)',
                        fontSize: '0.9rem',
                        marginTop: '8px',
                    }}
                >
                    Hash-locked cross-chain swap — MOTO {'>'} XMR
                </p>
            </div>

            <main
                style={{
                    flex: 1,
                    maxWidth: '1200px',
                    width: '100%',
                    margin: '0 auto',
                    padding: '12px 24px 64px',
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

            {/* Powered by OPNET */}
            <div
                style={{
                    textAlign: 'center',
                    padding: '40px 24px 16px',
                }}
            >
                <p
                    style={{
                        fontSize: 'clamp(1.2rem, 2.5vw, 1.8rem)',
                        fontWeight: 700,
                        color: 'var(--color-text-primary)',
                    }}
                >
                    Powered by{' '}
                    <span style={{ color: 'var(--color-orange)' }}>OPNET</span>
                </p>
            </div>

            <footer style={{ padding: '24px' }} />
        </>
    );
}
