/**
 * Structured JSON audit logger for critical coordinator events.
 *
 * Outputs one JSON object per line to stdout/stderr.
 * Target: ~30 most critical log points (state transitions, sweeps, errors, admin actions).
 * All other logging remains as console.* for now.
 */

export enum LogLevel {
    DEBUG = 'debug',
    INFO = 'info',
    WARN = 'warn',
    ERROR = 'error',
}

interface LogEntry {
    readonly ts: string;
    readonly level: LogLevel;
    readonly mod: string;
    readonly msg: string;
    readonly swapId?: string;
    readonly data?: Record<string, unknown>;
}

function emit(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === LogLevel.ERROR) {
        process.stderr.write(line + '\n');
    } else {
        process.stdout.write(line + '\n');
    }
}

export interface Logger {
    info(msg: string, swapId?: string, data?: Record<string, unknown>): void;
    warn(msg: string, swapId?: string, data?: Record<string, unknown>): void;
    error(msg: string, swapId?: string, data?: Record<string, unknown>): void;
}

export function createLogger(mod: string): Logger {
    return {
        info: (msg: string, swapId?: string, data?: Record<string, unknown>): void =>
            emit({ ts: new Date().toISOString(), level: LogLevel.INFO, mod, msg, swapId, data }),
        warn: (msg: string, swapId?: string, data?: Record<string, unknown>): void =>
            emit({ ts: new Date().toISOString(), level: LogLevel.WARN, mod, msg, swapId, data }),
        error: (msg: string, swapId?: string, data?: Record<string, unknown>): void =>
            emit({ ts: new Date().toISOString(), level: LogLevel.ERROR, mod, msg, swapId, data }),
    };
}
