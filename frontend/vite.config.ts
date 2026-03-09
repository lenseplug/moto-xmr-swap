import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import eslint from 'vite-plugin-eslint2';

export default defineConfig({
    base: './',
    plugins: [
        nodePolyfills({
            globals: {
                Buffer: true,
                global: true,
                process: true,
            },
            overrides: {
                crypto: 'crypto-browserify',
            },
        }),
        react(),
        eslint({ cache: false }),
    ],
    resolve: {
        alias: {
            global: 'global',
            undici: resolve(__dirname, 'node_modules/opnet/src/fetch/fetch-browser.js'),
        },
        mainFields: ['module', 'main', 'browser'],
        dedupe: ['@noble/curves', '@noble/hashes', '@scure/base', 'buffer', 'react', 'react-dom'],
    },
    build: {
        commonjsOptions: {
            strictRequires: true,
            transformMixedEsModules: true,
        },
        rollupOptions: {
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: 'js/[name]-[hash].js',
                assetFileNames: (assetInfo) => {
                    const name = assetInfo.names?.[0] ?? '';
                    const info = name.split('.');
                    const ext = info[info.length - 1];
                    if (/png|jpe?g|svg|gif|tiff|bmp|ico/i.test(ext ?? '')) return `images/[name][extname]`;
                    if (/woff|woff2|eot|ttf|otf/i.test(ext ?? '')) return `fonts/[name][extname]`;
                    if (/css/i.test(ext ?? '')) return `css/[name][extname]`;
                    return `assets/[name][extname]`;
                },
                manualChunks(id): string | undefined {
                    if (id.includes('crypto-browserify') || id.includes('randombytes')) return undefined;
                    if (id.includes('node_modules')) {
                        if (id.includes('@noble/curves')) return 'noble-curves';
                        if (id.includes('@noble/hashes')) return 'noble-hashes';
                        if (id.includes('@scure/')) return 'scure';
                        if (id.includes('@btc-vision/transaction')) return 'btc-transaction';
                        if (id.includes('@btc-vision/bitcoin')) return 'btc-bitcoin';
                        if (id.includes('@btc-vision/bip32')) return 'btc-bip32';
                        if (id.includes('@btc-vision/post-quantum')) return 'btc-post-quantum';
                        if (id.includes('@btc-vision/wallet-sdk')) return 'btc-wallet-sdk';
                        if (id.includes('@btc-vision/logger')) return 'btc-logger';
                        if (id.includes('@btc-vision/walletconnect')) return 'btc-walletconnect';
                        if (id.includes('node_modules/opnet')) return 'opnet';
                        if (id.includes('bip39')) return 'bip39';
                        if (id.includes('ecpair') || id.includes('tiny-secp256k1')) return 'bitcoin-utils';
                        if (
                            id.includes('node_modules/react-dom') ||
                            id.includes('node_modules/react/') ||
                            id.includes('node_modules/scheduler')
                        ) return 'react-ui';
                        if (id.includes('ethers')) return 'ethers';
                        if (id.includes('protobufjs') || id.includes('@protobufjs')) return 'protobuf';
                    }
                    return undefined;
                },
            },
            external: [
                'worker_threads',
                'node:sqlite',
                'node:diagnostics_channel',
                'node:async_hooks',
                'node:perf_hooks',
                'node:worker_threads',
            ],
        },
        target: 'esnext',
        modulePreload: false,
        cssCodeSplit: false,
        assetsInlineLimit: 10000,
        chunkSizeWarningLimit: 3000,
    },
    optimizeDeps: {
        include: ['react', 'react-dom', 'buffer', 'process', 'stream-browserify'],
        exclude: ['@btc-vision/transaction', 'crypto-browserify'],
    },
});
