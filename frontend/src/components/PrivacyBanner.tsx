/**
 * Privacy banner recommending fresh XMR address use.
 */
import React from 'react';

/**
 * Displays a privacy notice about XMR address reuse.
 */
export function PrivacyBanner(): React.ReactElement {
    return (
        <div
            style={{
                display: 'flex',
                gap: '12px',
                padding: '14px 16px',
                background: 'rgba(124, 58, 237, 0.08)',
                border: '1px solid rgba(124, 58, 237, 0.25)',
                borderRadius: 'var(--radius-md)',
                alignItems: 'flex-start',
            }}
        >
            <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(124, 58, 237, 0.9)"
                strokeWidth="2"
                style={{ flexShrink: 0, marginTop: '1px' }}
            >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <div>
                <p
                    style={{
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: 'rgba(200, 180, 255, 0.95)',
                        marginBottom: '4px',
                    }}
                >
                    Privacy Recommendation
                </p>
                <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                    Use a <strong style={{ color: 'var(--color-text-primary)' }}>fresh Monero address</strong> for
                    each swap to maximize privacy. Reusing XMR addresses links your swaps on-chain and reduces the
                    anonymity set provided by Monero.
                </p>
            </div>
        </div>
    );
}
