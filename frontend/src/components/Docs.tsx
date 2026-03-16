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
    background: 'rgba(232, 115, 42, 0.2)',
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
                    About MOTO-XMR Swap
                </h2>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
                    Cross-chain swaps between MOTO and Monero, secured by on-chain HTLCs and split-key cryptography.
                </p>
            </div>

            {/* Visual: MOTO <-> XMR */}
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
                    <img
                        src={motoLogo}
                        alt="MOTO"
                        width={56}
                        height={56}
                        style={{ borderRadius: '50%', boxShadow: '0 0 24px rgba(196, 86, 255, 0.25)' }}
                    />
                    <p style={{ fontSize: '0.8rem', fontWeight: 600, color: '#c456ff', marginTop: '8px' }}>MOTO</p>
                    <p style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>OPNet Bitcoin L1</p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        padding: '6px 16px',
                        background: 'rgba(232, 115, 42, 0.08)',
                        border: '1px solid rgba(232, 115, 42, 0.2)',
                        borderRadius: '999px',
                    }}>
                        <span style={{ color: 'var(--color-text-muted)', fontSize: '1.2rem' }}>&larr;</span>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-accent)', letterSpacing: '0.05em' }}>
                            SWAP
                        </span>
                        <span style={{ color: 'var(--color-text-muted)', fontSize: '1.2rem' }}>&rarr;</span>
                    </div>
                    <p style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)' }}>HTLC + Split Keys + DLEQ</p>
                </div>

                <div style={{ textAlign: 'center' }}>
                    <img
                        src={xmrLogo}
                        alt="XMR"
                        width={56}
                        height={56}
                        style={{ borderRadius: '50%', boxShadow: '0 0 24px rgba(242, 104, 34, 0.25)' }}
                    />
                    <p style={{ fontSize: '0.8rem', fontWeight: 600, color: '#f26822', marginTop: '8px' }}>XMR</p>
                    <p style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>Monero</p>
                </div>
            </div>

            {/* Swap Flow */}
            <div className="glass-card" style={{ padding: '24px', marginBottom: '20px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '20px', color: 'var(--color-text-primary)' }}>
                    How It Works
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                    <Step
                        num={1}
                        title="Create a Swap"
                        desc="The seller locks MOTO tokens in the on-chain HTLC vault contract and specifies the XMR amount. A cryptographic secret (preimage), ed25519 key pair, and cross-curve DLEQ proof are generated locally in the browser. Keys never leave your device."
                        accent="#c456ff"
                        bg="rgba(196, 86, 255, 0.1)"
                    />
                    <Connector />
                    <Step
                        num={2}
                        title="Buyer Takes the Swap"
                        desc="A counterparty accepts the offer. They generate their own ed25519 key pair and DLEQ proof locally. Both parties' public keys are combined to create a shared Monero escrow address that neither party can spend from alone."
                        accent="#f26822"
                        bg="rgba(242, 104, 34, 0.1)"
                    />
                    <Connector />
                    <Step
                        num={3}
                        title="XMR Escrow"
                        desc="XMR is deposited into the shared split-key escrow address. The deposit is monitored on the Monero network and requires 10 confirmations (~20 minutes) before the swap can proceed. Both parties can verify the DLEQ proofs to confirm the escrow address is valid."
                        accent="#f26822"
                        bg="rgba(242, 104, 34, 0.1)"
                    />
                    <Connector />
                    <Step
                        num={4}
                        title="Sweep-Before-Claim"
                        desc="Once XMR is confirmed, the coordinator sweeps the XMR to the seller's wallet BEFORE the secret is revealed. This ensures the seller has their Monero before the buyer can claim MOTO — eliminating the race window between preimage revelation and XMR delivery."
                        accent="#00e676"
                        bg="rgba(0, 230, 118, 0.1)"
                    />
                    <Connector />
                    <Step
                        num={5}
                        title="Claim MOTO"
                        desc="After XMR is secured, the preimage is broadcast to the buyer. They claim MOTO tokens by revealing the preimage on-chain, completing the swap. A 0.87% fee is collected from the XMR amount."
                        accent="#c456ff"
                        bg="rgba(196, 86, 255, 0.1)"
                    />
                </div>
            </div>

            {/* Security Model */}
            <div className="glass-card" style={{ padding: '24px', marginBottom: '20px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '16px', color: 'var(--color-text-primary)' }}>
                    Security Model
                </h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ padding: '12px 14px', background: 'rgba(0, 230, 118, 0.06)', border: '1px solid rgba(0, 230, 118, 0.15)', borderRadius: 'var(--radius-md)' }}>
                        <p style={{ fontSize: '0.82rem', fontWeight: 600, color: '#00e676', marginBottom: '4px' }}>
                            Non-custodial (MOTO side)
                        </p>
                        <ul style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', paddingLeft: '16px', lineHeight: 1.6 }}>
                            <li>MOTO tokens are locked in a hash-time locked contract (HTLC) on Bitcoin L1 via OPNet</li>
                            <li>The seller can always refund their MOTO after the timelock expires — no one can prevent this</li>
                            <li>The buyer can only claim MOTO by revealing the correct preimage on-chain</li>
                            <li>The coordinator cannot steal or freeze locked MOTO tokens</li>
                        </ul>
                    </div>

                    <div style={{ padding: '12px 14px', background: 'rgba(100, 181, 246, 0.06)', border: '1px solid rgba(100, 181, 246, 0.15)', borderRadius: 'var(--radius-md)' }}>
                        <p style={{ fontSize: '0.82rem', fontWeight: 600, color: '#64b5f6', marginBottom: '4px' }}>
                            Split-key escrow (XMR side)
                        </p>
                        <ul style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', paddingLeft: '16px', lineHeight: 1.6 }}>
                            <li>The XMR escrow address is a shared Monero address derived from both parties&apos; keys — neither can spend alone</li>
                            <li>Cross-curve DLEQ proofs verify that each party&apos;s keys are mathematically valid — your browser checks this independently</li>
                            <li>Sweep-before-claim: XMR is sent to the seller <em>before</em> the preimage goes public, preventing front-running</li>
                            <li>All key generation happens locally in your browser using cryptographically secure randomness</li>
                        </ul>
                    </div>

                    <div style={{ padding: '12px 14px', background: 'rgba(255, 215, 64, 0.06)', border: '1px solid rgba(255, 215, 64, 0.15)', borderRadius: 'var(--radius-md)' }}>
                        <p style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--color-text-warning)', marginBottom: '4px' }}>
                            Coordinator role
                        </p>
                        <ul style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', paddingLeft: '16px', lineHeight: 1.6 }}>
                            <li>The coordinator facilitates the swap by combining key shares and executing the XMR sweep</li>
                            <li>It must be online and responsive for swaps to complete on the XMR side</li>
                            <li>The coordinator cannot steal MOTO (on-chain HTLC) but is trusted with the XMR sweep execution</li>
                            <li>Sensitive data (preimages, view keys) is encrypted at rest and scrubbed after swap completion</li>
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
                        ['Privacy', 'No KYC. Fresh Monero escrow addresses per swap. Keys scrubbed after completion.'],
                        ['Recovery', 'Mnemonic backup allows swap recovery if browser data is lost'],
                        ['Verification', 'DLEQ proofs are verified client-side — your browser independently confirms key validity'],
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
