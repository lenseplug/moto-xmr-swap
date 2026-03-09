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

            <main
                style={{
                    flex: 1,
                    maxWidth: '1200px',
                    width: '100%',
                    margin: '0 auto',
                    padding: '32px 24px 64px',
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

            <footer
                style={{
                    borderTop: '1px solid var(--color-border-subtle)',
                    padding: '20px 24px',
                    textAlign: 'center',
                    fontSize: '0.78rem',
                    color: 'var(--color-text-muted)',
                }}
            >
                MOTO-XMR Swap — Trustless atomic exchange on OPNet Testnet.
                <span style={{ marginLeft: '16px' }}>
                    <a
                        href="https://mempool.opnet.org/testnet4"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="explorer-link"
                        style={{ display: 'inline-flex' }}
                    >
                        Mempool
                    </a>
                </span>
                <span style={{ marginLeft: '12px' }}>
                    <a
                        href="https://opscan.org/?network=op_testnet"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="explorer-link"
                        style={{ display: 'inline-flex' }}
                    >
                        OPScan
                    </a>
                </span>
            </footer>
        </>
    );
}
