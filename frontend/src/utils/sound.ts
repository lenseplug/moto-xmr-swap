/**
 * Web Audio API notification sounds — zero dependencies, no audio files.
 * Respects prefers-reduced-motion.
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

    if (!audioCtx) {
        audioCtx = new AudioContext();
    }
    // Resume suspended context (browser autoplay policy)
    if (audioCtx.state === 'suspended') {
        void audioCtx.resume();
    }
    return audioCtx;
}

function playTone(frequency: number, startTime: number, duration: number, ctx: AudioContext): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.15, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
}

export type SoundType = 'alert' | 'success' | 'complete';

export function playSound(type: SoundType): void {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    switch (type) {
        case 'alert':
            // Single 880Hz tone, 200ms
            playTone(880, now, 0.2, ctx);
            break;
        case 'success':
            // Two ascending tones
            playTone(660, now, 0.15, ctx);
            playTone(880, now + 0.15, 0.2, ctx);
            break;
        case 'complete':
            // Three ascending tones
            playTone(523, now, 0.12, ctx);
            playTone(659, now + 0.12, 0.12, ctx);
            playTone(784, now + 0.24, 0.25, ctx);
            break;
    }
}
