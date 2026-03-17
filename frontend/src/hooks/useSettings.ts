/**
 * Persisted user preferences hook.
 * Uses localStorage for non-critical UI preferences (NOT swap data).
 */
import { useState, useCallback } from 'react';

const STORAGE_KEY = 'moto_xmr_settings';

export interface Settings {
    soundEnabled: boolean;
    alertsEnabled: boolean;
}

const DEFAULTS: Settings = {
    soundEnabled: true,
    alertsEnabled: true,
};

function loadSettings(): Settings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULTS;
        const parsed = JSON.parse(raw) as Partial<Settings>;
        return { ...DEFAULTS, ...parsed };
    } catch {
        return DEFAULTS;
    }
}

function saveSettings(settings: Settings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // localStorage unavailable — silently ignore
    }
}

export function useSettings(): {
    settings: Settings;
    updateSettings: (patch: Partial<Settings>) => void;
} {
    const [settings, setSettings] = useState<Settings>(loadSettings);

    const updateSettings = useCallback((patch: Partial<Settings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch };
            saveSettings(next);
            return next;
        });
    }, []);

    return { settings, updateSettings };
}
