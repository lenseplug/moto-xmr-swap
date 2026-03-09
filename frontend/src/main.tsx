/**
 * Application entry point.
 * Wraps the app in WalletConnectProvider (v2 API).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WalletConnectProvider } from '@btc-vision/walletconnect';
import App from './App';
import './styles/global.css';

const rootElement = document.getElementById('root');
if (rootElement === null) {
    throw new Error('Root element #root not found in DOM');
}

createRoot(rootElement).render(
    <React.StrictMode>
        <WalletConnectProvider theme="dark">
            <App />
        </WalletConnectProvider>
    </React.StrictMode>,
);
