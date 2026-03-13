import React from 'react';
import motoLogo from '../assets/motoswap-logo.png';
import xmrLogo from '../assets/monero-xmr-logo.png';

const stepIcon: React.CSSProperties = {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: '0.95rem',
    flexShrink: 0,
};

const connector: React.CSSProperties = {
    width: '2px',
    height: '20px',
    background: 'rgba(255, 107, 0, 0.2)',
    margin: '0 auto',
};

interface StepProps {
    readonly num: number;
    readonly title: string;
    readonly desc: string;
    readonly accent: string;
    readonly bg: string;
}

function Step({ num, title, desc, accent, bg }: StepProps): React.ReactElement {
    return (
        <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
            <div style={{ ...stepIcon, background: bg, color: accent, border: `1px solid ${accent}33` }}>
                {num}
            </div>
            <div style={{ flex: 1, paddingTop: '2px' }}>
                <p style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--color-text-primary)', marginBottom: '4px' }}>
                    {title}
                </p>
                <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
                    {desc}
                </p>
            </div>
        </div>
    );
}

function Connector(): React.ReactElement {
    return <div style={connector} />;
}

export function Docs(): React.ReactElement {
    return (
        <div style={{ maxWidth: '680px' }}>
            {/* Header */}
            <div style={{ marginBottom: '32px' }}>
                <h2 style={{ fontSize: '1.35rem', fontWeight: 700, marginBottom: '6px' }}>
                    About OPNero
                </h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                    Private cross-chain swaps between OP-20 tokens and Monero, secured by hash-time locked contracts.
                </p>
            </div>

            {/* Visual: OP-20 <-> XMR */}
            <div
                className="glass-card"
                style={{
                    padding: '28px 24px',
                    marginBottom: '20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '24px',
                }}
            >
                <div style={{ textAlign: 'center' }}>
                    <div
                        style={{
                            width: 56,
                            height: 56,
                            borderRadius: '50%',
                            background: 'linear-gradient(135deg, #ff6b00, #ff8533)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '0.85rem',
                            fontWeight: 700,
                            color: '#fff',
                            boxShadow: '0 0 24px rgba(255, 107, 0, 0.25)',
                        }}
                    >
                        OP
                    </div>
                    <p style={{ fontSize: '0.8rem', fontWeight: 600, color: '#ff6b00', marginTop: '8px' }}>OP-20</p>
                    <p style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>OPNet Bitcoin L1</p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '6px 16px',
                        background: 'rgba(255, 107, 0, 0.08)',
                        border: '1px solid rgba(255, 107, 0, 0.2)',
                        borderRadius: '999px',
                    }}>
                        <span style={{ color: 'var(--color-text-muted)', fontSize: '1.2rem' }}>&larr;</span>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#ff6b00', letterSpacing: '0.05em' }}>
                            SWAP
                        </span>
                        <span style={{ color: 'var(--color-text-muted)', fontSize: '1.2rem' }}>&rarr;</span>
                    </div>
                    <p style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)' }}>HTLC + Split Keys</p>
                </div>

                <div style={{ textAlign: 'center' }}>
                    <div
                        style={{
                            width: 56,
                            height: 56,
                            borderRadius: '50%',
                            background: 'linear-gradient(135deg, #f26822, #ff8533)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '0.85rem',
                            fontWeight: 700,
                            color: '#fff',
                            boxShadow: '0 0 24px rgba(242, 104, 34, 0.25)',
                        }}
                    >
                        M
                    </div>
                    <p style={{ fontSize: '0.8rem', fontWeight: 600, color: '#f26822', marginTop: '8px' }}>XMR</p>
                    <p style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>Monero</p>
                </div>
            </div>

            {/* Swap Flow */}
            <div className="glass-card" style={{ padding: '24px', marginBottom: '20px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '20px', color: 'var(--color-text-primary)' }}>
                    Swap Flow
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                    <Step
                        num={1}
                        title="Create a Swap"
                        desc="The seller locks MOTO tokens in the on-chain HTLC vault contract and specifies the XMR amount they want. A cryptographic secret and ed25519 key pair are generated locally in the browser."
                        accent="#c456ff"
                        bg="rgba(196, 86, 255, 0.1)"
                    />
                    <Connector />
                    <Step
                        num={2}
                        title="Buyer Takes the Swap"
                        desc="A counterparty accepts the offer from the order book. They generate their own ed25519 key pair and submit it to the coordinator. Both parties' keys combine to create a shared Monero escrow address."
                        accent="#f26822"
                        bg="rgba(242, 104, 34, 0.1)"
                    />
                    <Connector />
                    <Step
                        num={3}
                        title="XMR Escrow"
                        desc="The coordinator deposits XMR into the shared escrow address. The transaction is monitored on the Monero network and requires 10 confirmations before proceeding."
                        accent="#f26822"
                        bg="rgba(242, 104, 34, 0.1)"
                    />
                    <Connector />
                    <Step
                        num={4}
                        title="Claim MOTO"
                        desc="Once XMR is confirmed locked, the buyer claims the MOTO tokens by revealing the secret preimage on-chain. This proves they know the hash-lock secret without exposing it beforehand."
                        accent="#c456ff"
                        bg="rgba(196, 86, 255, 0.1)"
                    />
                    <Connector />
                    <Step
                        num={5}
                        title="XMR Sweep"
                        desc="The coordinator automatically sweeps the XMR from escrow to the seller's Monero wallet. A 0.87% fee is collected from the XMR amount."
                        accent="#00e676"
                        bg="rgba(0, 230, 118, 0.1)"
                    />
                </div>
            </div>

            {/* Trust Model */}
            <div className="glass-card" style={{ padding: '24px', marginBottom: '20px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '16px', color: 'var(--color-text-primary)' }}>
                    Trust Model
                </h3>
                <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: '16px' }}>
                    This is a <strong style={{ color: 'var(--color-text-primary)' }}>coordinator-mediated</strong> swap, not a fully trustless atomic swap. Here&apos;s what that means:
                </p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ padding: '12px 14px', background: 'rgba(0, 230, 118, 0.06)', border: '1px solid rgba(0, 230, 118, 0.15)', borderRadius: 'var(--radius-md)' }}>
                        <p style={{ fontSize: '0.82rem', fontWeight: 600, color: '#00e676', marginBottom: '4px' }}>
                            What IS secured on-chain
                        </p>
                        <ul style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', paddingLeft: '16px', lineHeight: 1.6 }}>
                            <li>MOTO tokens are locked in a hash-time locked contract (HTLC) on Bitcoin L1 via OPNet</li>
                            <li>The seller can always refund their MOTO after the timelock expires</li>
                            <li>The buyer can only claim MOTO by revealing the correct preimage</li>
                        </ul>
                    </div>

                    <div style={{ padding: '12px 14px', background: 'rgba(255, 215, 64, 0.06)', border: '1px solid rgba(255, 215, 64, 0.15)', borderRadius: 'var(--radius-md)' }}>
                        <p style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--color-text-warning)', marginBottom: '4px' }}>
                            What requires trust in the coordinator
                        </p>
                        <ul style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', paddingLeft: '16px', lineHeight: 1.6 }}>
                            <li>The coordinator holds both ed25519 key shares and manages the XMR escrow</li>
                            <li>XMR deposits and sweeps are handled by the coordinator&apos;s wallet</li>
                            <li>The coordinator must be online and honest for the XMR side to complete</li>
                        </ul>
                    </div>
                </div>
            </div>

            {/* Key Details */}
            <div className="glass-card" style={{ padding: '24px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '16px', color: 'var(--color-text-primary)' }}>
                    Key Details
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {[
                        ['Fee', '0.87% of XMR amount, paid by the buyer'],
                        ['Minimum XMR', '0.025 XMR per swap'],
                        ['Confirmations', '10 Monero confirmations required (~20 min)'],
                        ['Timelock', 'Configurable, default ~13 hours (80 blocks)'],
                        ['Refunds', 'Seller can reclaim MOTO after timelock expiry'],
                        ['Privacy', 'No KYC. Monero addresses are not stored long-term.'],
                    ].map(([label, value]) => (
                        <div key={label} style={{ display: 'flex', gap: '12px', fontSize: '0.85rem' }}>
                            <span style={{ color: 'var(--color-text-muted)', minWidth: '120px', flexShrink: 0, fontWeight: 600 }}>
                                {label}
                            </span>
                            <span style={{ color: 'var(--color-text-secondary)' }}>{value}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
