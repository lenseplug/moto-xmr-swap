/**
 * Collapsible activity log — timestamped events for swap progress.
 */
import React, { useState } from 'react';

export interface ActivityEvent {
    timestamp: number;
    label: string;
    type: 'info' | 'success' | 'warning' | 'error';
}

interface ActivityFeedProps {
    readonly events: ActivityEvent[];
}

const DOT_COLORS: Record<ActivityEvent['type'], string> = {
    info: 'var(--color-text-secondary)',
    success: 'var(--color-text-success)',
    warning: 'var(--color-text-warning)',
    error: 'var(--color-text-error)',
};

function formatTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ActivityFeed({ events }: ActivityFeedProps): React.ReactElement {
    const [expanded, setExpanded] = useState(false);

    if (events.length === 0) return <></>;

    return (
        <div
            className="glass-card"
            style={{ padding: '0', marginBottom: '16px', overflow: 'hidden' }}
        >
            <button
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
                style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '14px 18px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--color-text-secondary)',
                    fontFamily: 'var(--font-display)',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                }}
            >
                <span>
                    Activity Log
                    <span style={{
                        marginLeft: '8px',
                        fontSize: '0.72rem',
                        color: 'var(--color-text-muted)',
                        fontWeight: 400,
                    }}>
                        ({events.length})
                    </span>
                </span>
                <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{
                        transition: 'transform var(--transition-fast)',
                        transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    }}
                >
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>

            {expanded && (
                <div
                    role="log"
                    style={{
                        maxHeight: '300px',
                        overflowY: 'auto',
                        borderTop: '1px solid var(--color-border-subtle)',
                        padding: '12px 18px',
                    }}
                >
                    {[...events].reverse().map((evt, i) => (
                        <div
                            key={i}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '10px',
                                padding: '6px 0',
                                borderBottom: i < events.length - 1 ? '1px solid var(--color-border-subtle)' : 'none',
                            }}
                        >
                            <div
                                style={{
                                    width: '6px',
                                    height: '6px',
                                    borderRadius: '50%',
                                    background: DOT_COLORS[evt.type],
                                    flexShrink: 0,
                                }}
                            />
                            <span style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: '0.72rem',
                                color: 'var(--color-text-muted)',
                                flexShrink: 0,
                            }}>
                                {formatTime(evt.timestamp)}
                            </span>
                            <span style={{
                                fontSize: '0.8rem',
                                color: 'var(--color-text-secondary)',
                            }}>
                                {evt.label}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
