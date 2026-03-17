/**
 * Polls coordinator for aggregate swap statistics.
 */
import { useState, useEffect, useRef } from 'react';
import { getAllCoordinatorStatuses } from '../services/coordinator';

const POLL_INTERVAL_MS = 60_000;

interface SwapStats {
    active: number;
    completed: number;
}

export function useSwapStats(): SwapStats {
    const [stats, setStats] = useState<SwapStats>({ active: 0, completed: 0 });
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;

        const fetch = async (): Promise<void> => {
            try {
                const statuses = await getAllCoordinatorStatuses();
                if (!mountedRef.current) return;

                const terminal = new Set(['complete', 'refunded', 'error']);
                let active = 0;
                let completed = 0;
                for (const s of statuses) {
                    if (terminal.has(s.step)) {
                        completed++;
                    } else {
                        active++;
                    }
                }
                setStats({ active, completed });
            } catch {
                // silently ignore
            }
        };

        void fetch();
        const timer = setInterval(() => void fetch(), POLL_INTERVAL_MS);

        return () => {
            mountedRef.current = false;
            clearInterval(timer);
        };
    }, []);

    return stats;
}
