import { useEffect, useRef, useState } from 'react';
import { getProvider } from '../services/opnet';

interface BlockCountdownState {
    blockNumber: bigint | null;
    secondsToNextBlock: number | null;
    /** True when countdown reached 0 but block hasn't changed yet */
    waitingForBlock: boolean;
}

export function useBlockCountdown(pollIntervalMs = 15_000): BlockCountdownState {
    const [blockNumber, setBlockNumber] = useState<bigint | null>(null);
    const [secondsToNextBlock, setSecondsToNextBlock] = useState<number | null>(null);
    const [waitingForBlock, setWaitingForBlock] = useState(false);

    const lastBlockChangeTime = useRef<number | null>(null);
    const avgBlockTime = useRef<number>(240); // ~4min (OPNet average)
    const lastBlock = useRef<bigint | null>(null);

    // Poll for new blocks
    useEffect(() => {
        let cancelled = false;

        const fetchBlock = async (): Promise<void> => {
            try {
                const provider = getProvider();
                const height = await provider.getBlockNumber();
                if (cancelled) return;

                const bn = BigInt(height);
                setBlockNumber(bn);

                if (lastBlock.current !== null && bn > lastBlock.current) {
                    const now = Date.now();
                    if (lastBlockChangeTime.current !== null) {
                        const elapsed = (now - lastBlockChangeTime.current) / 1000;
                        // Smooth the average: weighted blend
                        avgBlockTime.current = avgBlockTime.current * 0.7 + elapsed * 0.3;
                    }
                    lastBlockChangeTime.current = now;
                    // Block changed — reset waiting state and restart countdown
                    setWaitingForBlock(false);
                }
                lastBlock.current = bn;
            } catch {
                // RPC hiccup — skip
            }
        };

        void fetchBlock();
        const interval = setInterval(() => void fetchBlock(), pollIntervalMs);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [pollIntervalMs]);

    // Countdown timer (1s tick)
    useEffect(() => {
        const tick = setInterval(() => {
            if (lastBlockChangeTime.current === null) {
                setSecondsToNextBlock(null);
                return;
            }
            const elapsed = (Date.now() - lastBlockChangeTime.current) / 1000;
            const remaining = Math.max(0, Math.round(avgBlockTime.current - elapsed));
            setSecondsToNextBlock(remaining);

            if (remaining === 0) {
                setWaitingForBlock(true);
            }
        }, 1000);

        return () => clearInterval(tick);
    }, []);

    return { blockNumber, secondsToNextBlock, waitingForBlock };
}
