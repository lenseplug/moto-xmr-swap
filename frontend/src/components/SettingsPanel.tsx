/**
 * Settings dropdown panel — sound + alert toggles.
 */
import React, { useEffect, useRef } from 'react';
import { useSettingsContext } from '../contexts/SettingsContext';

interface SettingsPanelProps {
    readonly onClose: () => void;
}

function Toggle({ checked, onChange, label }: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
}): React.ReactElement {
    return (
        <button
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            style={{
                width: '40px',
                height: '22px',
                borderRadius: '11px',
                border: 'none',
                background: checked ? 'var(--color-orange)' : 'rgba(255,255,255,0.12)',
                cursor: 'pointer',
                position: 'relative',
                transition: 'background var(--transition-fast)',
                flexShrink: 0,
            }}
        >
            <span
                style={{
                    position: 'absolute',
                    top: '2px',
                    left: checked ? '20px' : '2px',
                    width: '18px',
                    height: '18px',
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left var(--transition-fast)',
                }}
            />
        </button>
    );
}

export function SettingsPanel({ onClose }: SettingsPanelProps): React.ReactElement {
    const { settings, updateSettings } = useSettingsContext();
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent): void => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    useEffect(() => {
        const handler = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    return (
        <div
            ref={panelRef}
            role="dialog"
            aria-label="Settings"
            style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '8px',
                width: '260px',
                background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-card)',
                padding: '16px',
                zIndex: 200,
            }}
        >
            <p style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                color: 'var(--color-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: '14px',
            }}>
                Settings
            </p>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                    Sound notifications
                </span>
                <Toggle
                    checked={settings.soundEnabled}
                    onChange={(v) => updateSettings({ soundEnabled: v })}
                    label="Toggle sound notifications"
                />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                    Transaction alerts
                </span>
                <Toggle
                    checked={settings.alertsEnabled}
                    onChange={(v) => updateSettings({ alertsEnabled: v })}
                    label="Toggle transaction alerts"
                />
            </div>
        </div>
    );
}
