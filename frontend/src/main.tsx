/**
 * Application entry point.
 * Wraps the app in WalletConnectProvider (v2 API).
 */

// Prevent OPNet wallet extension from crashing the page by making window.opnet configurable
// before the extension's pageProvider.js tries to assign it as read-only.
try {
    if (typeof window !== 'undefined' && !Object.getOwnPropertyDescriptor(window, 'opnet')) {
        Object.defineProperty(window, 'opnet', {
            value: undefined,
            writable: true,
            configurable: true,
        });
    }
} catch {
    // Extension already defined it — ignore
}

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
