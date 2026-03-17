/**
 * Settings context — avoids prop drilling for sound/alert preferences.
 */
import React, { createContext, useContext } from 'react';
import { useSettings, type Settings } from '../hooks/useSettings';

interface SettingsContextValue {
    settings: Settings;
    updateSettings: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }): React.ReactElement {
    const value = useSettings();
    return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettingsContext(): SettingsContextValue {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error('useSettingsContext must be used within SettingsProvider');
    return ctx;
}
