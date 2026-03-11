/**
 * Test infrastructure for coordinator E2E tests.
 *
 * Provides:
 *   - CoordinatorProcess: manages coordinator as a child process
 *   - SwapApiClient: typed HTTP client wrapping all endpoints
 *   - WsClient: WebSocket wrapper for subscription testing
 *   - Crypto helpers: preimage/hashLock generation
 *   - TimingRecorder: performance metrics collection
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// CoordinatorProcess
// ---------------------------------------------------------------------------

const ADMIN_API_KEY = 'test-admin-key-that-is-at-least-32-chars-long';
/** Root directory of the coordinator project (parent of dist/). */
const COORDINATOR_ROOT = join(import.meta.dirname, '..', '..');
const COORDINATOR_DIST = join(COORDINATOR_ROOT, 'dist', 'src', 'index.js');

export interface ICoordinatorOpts {
    /** Override environment variables. */
    env?: Record<string, string>;
    /** Mock XMR confirmation delay in ms. Default: 2000 */
    mockConfirmDelay?: number;
    /** Path to a specific DB file (for restart tests). */
    dbPath?: string;
}

/** Finds a free TCP port by binding to port 0. */
async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.listen(0, () => {
            const addr = srv.address();
            if (typeof addr === 'object' && addr !== null) {
                const port = addr.port;
                srv.close(() => resolve(port));
            } else {
                srv.close(() => reject(new Error('Failed to get free port')));
            }
        });
        srv.on('error', reject);
    });
}

/** Manages a coordinator child process for testing. */
export class CoordinatorProcess {
    public port = 0;
    public readonly dbPath: string;
    private proc: ChildProcess | null = null;
    private readonly envOverrides: Record<string, string>;
    private readonly mockConfirmDelay: number;

    public constructor(opts: ICoordinatorOpts = {}) {
        const rnd = randomBytes(8).toString('hex');
        this.dbPath = opts.dbPath ?? join(tmpdir(), `coordinator-test-${rnd}.db`);
        this.envOverrides = opts.env ?? {};
        this.mockConfirmDelay = opts.mockConfirmDelay ?? 2000;
    }

    /** Starts the coordinator. Resolves when HTTP server is listening. */
    public async start(): Promise<void> {
        this.port = await getFreePort();

        const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            PORT: String(this.port),
            DB_PATH: this.dbPath,
            ADMIN_API_KEY,
            MONERO_MOCK: 'true',
            XMR_MOCK_CONFIRM_DELAY_MS: String(this.mockConfirmDelay),
            SWAP_CONTRACT_ADDRESS: '',
            MOCK_BLOCK_HEIGHT: '1000',
            RATE_LIMIT_DISABLED: 'true',
            CORS_ORIGIN: '*',
            DB_BACKUP_INTERVAL_MS: '0',
            ...this.envOverrides,
        };

        return new Promise<void>((resolve, reject) => {
            this.proc = spawn('node', [COORDINATOR_DIST], {
                env,
                cwd: COORDINATOR_ROOT,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Coordinator did not start within 10s'));
                }
            }, 10_000);

            this.proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                if (!resolved && text.includes('HTTP server listening')) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve();
                }
            });

            let stderrBuf = '';
            this.proc.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                stderrBuf += text;
                if (!resolved && (text.includes('Fatal error') || text.includes('ERR_'))) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(new Error(`Coordinator failed to start: ${stderrBuf}`));
                }
            });

            this.proc.on('error', (err: Error) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(err);
                }
            });

            this.proc.on('exit', (code: number | null) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(new Error(`Coordinator exited with code ${code}: ${stderrBuf}`));
                }
            });
        });
    }

    /** Kills the coordinator process. */
    public async kill(): Promise<void> {
        if (!this.proc) return;
        const proc = this.proc;
        this.proc = null;
        return new Promise<void>((resolve) => {
            proc.on('exit', () => resolve());
            proc.kill('SIGTERM');
            // Force kill after 3s
            const t = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch { /* already dead */ }
                resolve(); // resolve even if force kill
            }, 3000);
            proc.on('exit', () => clearTimeout(t));
        });
    }

    /** Kills and restarts the coordinator (preserves DB). */
    public async restart(): Promise<void> {
        await this.kill();
        await this.start();
    }

    /** Returns the base URL for the coordinator. */
    public get baseUrl(): string {
        return `http://localhost:${this.port}`;
    }
}

// ---------------------------------------------------------------------------
// SwapApiClient
// ---------------------------------------------------------------------------

export interface IApiResult<T = unknown> {
    status: number;
    body: {
        success: boolean;
        data: T | null;
        error: { code: string; message: string; retryable: boolean } | null;
    };
    headers: Record<string, string>;
}

/** HTTP client wrapping all coordinator API endpoints. */
export class SwapApiClient {
    private readonly baseUrl: string;
    private readonly apiKey: string;

    public constructor(baseUrl: string, apiKey = ADMIN_API_KEY) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }

    /** POST /api/swaps — create a new swap. */
    public async createSwap(params: {
        swap_id: string;
        hash_lock: string;
        refund_block: number;
        moto_amount: string;
        xmr_amount: string;
        depositor: string;
        opnet_create_tx?: string;
        alice_xmr_payout?: string;
    }): Promise<IApiResult> {
        return this.request('POST', '/api/swaps', params, true);
    }

    /** POST /api/swaps/:id/take */
    public async takeSwap(swapId: string, opnetTxId: string): Promise<IApiResult> {
        return this.request('POST', `/api/swaps/${swapId}/take`, { opnetTxId });
    }

    /** POST /api/swaps/:id/secret */
    public async submitSecret(
        swapId: string,
        secret: string,
        aliceViewKey?: string,
    ): Promise<IApiResult> {
        const body: Record<string, string> = { secret };
        if (aliceViewKey) body['aliceViewKey'] = aliceViewKey;
        return this.request('POST', `/api/swaps/${swapId}/secret`, body);
    }

    /** POST /api/swaps/:id/keys */
    public async submitKeys(
        swapId: string,
        keys: {
            bobEd25519PubKey: string;
            bobViewKey: string;
            bobKeyProof: string;
            bobSpendKey?: string;
        },
    ): Promise<IApiResult> {
        return this.request('POST', `/api/swaps/${swapId}/keys`, keys);
    }

    /** GET /api/swaps/:id */
    public async getSwap(swapId: string): Promise<IApiResult> {
        return this.request('GET', `/api/swaps/${swapId}`);
    }

    /** GET /api/swaps */
    public async listSwaps(page = 1, limit = 20): Promise<IApiResult> {
        return this.request('GET', `/api/swaps?page=${page}&limit=${limit}`);
    }

    /** PUT /api/admin/swaps/:id — test-only admin endpoint */
    public async adminUpdate(
        swapId: string,
        fields: Record<string, string | number | null>,
    ): Promise<IApiResult> {
        return this.request('PUT', `/api/admin/swaps/${swapId}`, fields, true);
    }

    /** GET /api/health */
    public async health(): Promise<IApiResult> {
        return this.request('GET', '/api/health');
    }

    /** GET /api/fee-address */
    public async getFeeAddress(): Promise<IApiResult> {
        return this.request('GET', '/api/fee-address');
    }

    /** PUT /api/fee-address */
    public async setFeeAddress(address: string): Promise<IApiResult> {
        return this.request('PUT', '/api/fee-address', { address }, true);
    }

    /** Raw request for edge-case testing. */
    public async raw(
        method: string,
        path: string,
        body?: unknown,
        admin = false,
    ): Promise<IApiResult> {
        return this.request(method, path, body, admin);
    }

    private async request(
        method: string,
        path: string,
        body?: unknown,
        admin = false,
    ): Promise<IApiResult> {
        const url = `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };
        if (admin) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const opts: RequestInit = { method, headers };
        if (body !== undefined && method !== 'GET') {
            opts.body = JSON.stringify(body);
        }

        const res = await fetch(url, opts);
        const text = await res.text();
        let parsed: IApiResult['body'];
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = { success: false, data: null, error: { code: 'PARSE_ERROR', message: text, retryable: false } };
        }

        const resHeaders: Record<string, string> = {};
        res.headers.forEach((val, key) => {
            resHeaders[key] = val;
        });

        return { status: res.status, body: parsed, headers: resHeaders };
    }
}

// ---------------------------------------------------------------------------
// WsClient
// ---------------------------------------------------------------------------

export interface IWsMessage {
    type: string;
    data: unknown;
}

/** WebSocket client wrapper for testing. */
export class WsClient {
    private ws: WebSocket | null = null;
    public readonly messages: IWsMessage[] = [];
    private messageResolvers: Array<(msg: IWsMessage) => void> = [];

    public constructor(private readonly baseUrl: string) {}

    /** Connect to the WebSocket server. Resolves when the connection is open. */
    public async connect(): Promise<void> {
        const wsUrl = this.baseUrl.replace('http://', 'ws://');
        return new Promise<void>((resolve, reject) => {
            this.ws = new WebSocket(wsUrl);
            this.ws.on('open', () => resolve());
            this.ws.on('error', (err: Error) => reject(err));
            this.ws.on('message', (raw: Buffer | string) => {
                try {
                    const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) as IWsMessage;
                    this.messages.push(msg);
                    // Resolve any pending waiters
                    if (this.messageResolvers.length > 0) {
                        const resolver = this.messageResolvers.shift();
                        resolver?.(msg);
                    }
                } catch {
                    // ignore malformed
                }
            });
        });
    }

    /** Subscribe to a swap with an optional claim token. */
    public subscribe(swapId: string, claimToken?: string): void {
        this.ws?.send(JSON.stringify({ type: 'subscribe', swapId, claimToken }));
    }

    /** Waits for the next message matching a type. */
    public async waitForMessage(type: string, timeoutMs = 10000): Promise<IWsMessage> {
        // Check if we already have it
        const existing = this.messages.find((m) => m.type === type);
        if (existing) return existing;

        return new Promise<IWsMessage>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timeout waiting for WS message type '${type}' after ${timeoutMs}ms`));
            }, timeoutMs);

            const check = (msg: IWsMessage): void => {
                if (msg.type === type) {
                    clearTimeout(timeout);
                    resolve(msg);
                } else {
                    // Re-queue ourselves
                    this.messageResolvers.push(check);
                }
            };
            this.messageResolvers.push(check);
        });
    }

    /** Waits for preimage_ready message. */
    public async waitForPreimage(timeoutMs = 15000): Promise<string> {
        const msg = await this.waitForMessage('preimage_ready', timeoutMs);
        const data = msg.data as { preimage?: string };
        return data.preimage ?? '';
    }

    /** Close the WebSocket connection. */
    public close(): void {
        this.ws?.close();
        this.ws = null;
    }

    /** Returns messages of a specific type. */
    public getMessages(type: string): IWsMessage[] {
        return this.messages.filter((m) => m.type === type);
    }

    /** Clears all collected messages. */
    public clearMessages(): void {
        this.messages.length = 0;
    }
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/** Generates a random 32-byte preimage and its SHA-256 hash lock. */
export function generatePreimageAndHash(): { preimage: string; hashLock: string } {
    const preimageBytes = randomBytes(32);
    const preimage = preimageBytes.toString('hex');
    const hashLock = createHash('sha256').update(preimageBytes).digest('hex');
    return { preimage, hashLock };
}

let swapCounter = 100000;

/** Generates valid swap creation params with unique numeric IDs. */
export function generateSwapParams(_label = ''): {
    params: {
        swap_id: string;
        hash_lock: string;
        refund_block: number;
        moto_amount: string;
        xmr_amount: string;
        depositor: string;
    };
    preimage: string;
} {
    swapCounter++;
    const { preimage, hashLock } = generatePreimageAndHash();
    return {
        params: {
            swap_id: String(swapCounter),
            hash_lock: hashLock,
            refund_block: 999999,
            moto_amount: '100000000000000000000',
            xmr_amount: '1000000000000', // 1 XMR in piconero
            depositor: 'opt1sqtest' + randomBytes(16).toString('hex'),
        },
        preimage,
    };
}

/** Resets the swap counter (call between test suites). */
export function resetSwapCounter(): void {
    swapCounter = 0;
}

// ---------------------------------------------------------------------------
// TimingRecorder
// ---------------------------------------------------------------------------

interface ITimingEntry {
    operation: string;
    durationMs: number;
}

/** Records operation timings and prints a summary table. */
export class TimingRecorder {
    private readonly entries: ITimingEntry[] = [];

    public record(operation: string, durationMs: number): void {
        this.entries.push({ operation, durationMs });
    }

    public async time<T>(operation: string, fn: () => Promise<T>): Promise<T> {
        const start = performance.now();
        const result = await fn();
        this.record(operation, performance.now() - start);
        return result;
    }

    public printSummary(): void {
        if (this.entries.length === 0) return;

        // Group by operation
        const grouped = new Map<string, number[]>();
        for (const entry of this.entries) {
            let arr = grouped.get(entry.operation);
            if (!arr) {
                arr = [];
                grouped.set(entry.operation, arr);
            }
            arr.push(entry.durationMs);
        }

        console.log('\n=== Performance Summary ===');
        console.log('Operation'.padEnd(30) + 'Avg(ms)'.padStart(10) + 'Min(ms)'.padStart(10) + 'Max(ms)'.padStart(10) + 'Count'.padStart(8));
        console.log('-'.repeat(68));

        for (const [op, times] of grouped) {
            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            const min = Math.min(...times);
            const max = Math.max(...times);
            console.log(
                op.padEnd(30) +
                avg.toFixed(1).padStart(10) +
                min.toFixed(1).padStart(10) +
                max.toFixed(1).padStart(10) +
                String(times.length).padStart(8),
            );
        }
        console.log('');
    }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Sleep for the given duration in ms. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The admin API key used by tests. */
export { ADMIN_API_KEY };
