/**
 * App footer — swap stats, links, and branding.
 */
import React from 'react';
import { useSwapStats } from '../hooks/useSwapStats';

export function Footer(): React.ReactElement {
    const { active, completed } = useSwapStats();

    return (
        <footer style={{ padding: '40px 24px 24px', maxWidth: '1200px', margin: '0 auto', width: '100%' }}>
            {/* Stats */}
            <div style={{
                display: 'flex',
                justifyContent: 'center',
                gap: '24px',
                marginBottom: '28px',
                flexWrap: 'wrap',
            }}>
                <div className="glass-card" style={{
                    padding: '16px 28px',
                    textAlign: 'center',
                    minWidth: '140px',
                }}>
                    <p style={{
                        fontSize: '1.4rem',
                        fontWeight: 700,
                        color: 'var(--color-orange)',
                        fontVariantNumeric: 'tabular-nums',
                    }}>
                        {active}
                    </p>
                    <p style={{
                        fontSize: '0.72rem',
                        color: 'var(--color-text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        fontWeight: 600,
                    }}>
                        Active Swaps
                    </p>
                </div>
                <div className="glass-card" style={{
                    padding: '16px 28px',
                    textAlign: 'center',
                    minWidth: '140px',
                }}>
                    <p style={{
                        fontSize: '1.4rem',
                        fontWeight: 700,
                        color: 'var(--color-orange)',
                        fontVariantNumeric: 'tabular-nums',
                    }}>
                        {completed}
                    </p>
                    <p style={{
                        fontSize: '0.72rem',
                        color: 'var(--color-text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        fontWeight: 600,
                    }}>
                        Completed
                    </p>
                </div>
            </div>

            {/* Links */}
            <div style={{
                display: 'flex',
                justifyContent: 'center',
                gap: '24px',
                marginBottom: '20px',
                flexWrap: 'wrap',
            }}>
                <a
                    href="https://github.com/lenseplug/moto-xmr-swap"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '0.82rem',
                        color: 'var(--color-text-secondary)',
                    }}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                    </svg>
                    GitHub
                </a>
                <a
                    href="https://opnet.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '0.82rem',
                        color: 'var(--color-text-secondary)',
                    }}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
                    </svg>
                    OP_NET
                </a>
                <a
                    href="https://opscan.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '0.82rem',
                        color: 'var(--color-text-secondary)',
                    }}
                >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="11" cy="11" r="8"/>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    OP_SCAN
                </a>
            </div>

            {/* Branding */}
            <div style={{ textAlign: 'center' }}>
                <p style={{
                    fontSize: 'clamp(1.2rem, 2.5vw, 1.8rem)',
                    fontWeight: 700,
                    color: 'var(--color-text-primary)',
                    marginBottom: '8px',
                }}>
                    Powered by{' '}
                    <span style={{ color: 'var(--color-orange)' }}>OPNET</span>
                </p>
                <p style={{
                    fontSize: '0.72rem',
                    color: 'var(--color-text-muted)',
                    letterSpacing: '0.04em',
                }}>
                    2026 Motonero
                </p>
            </div>
        </footer>
    );
}
