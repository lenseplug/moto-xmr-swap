/**
 * E2E test helpers for the MOTO-XMR coordinator.
 *
 * Provides:
 *   - CoordinatorProcess  — lifecycle manager for a coordinator child process
 *   - SwapApiClient       — typed HTTP client for every coordinator endpoint
 *   - WsClient            — WebSocket wrapper with message collection & typed waiting
 *   - Crypto helpers      — preimage/hash, Ed25519 Bob keys, Schnorr proofs
 *   - Utilities           — wait(), uniqueId(), makeSwapParams()
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default admin key used throughout tests. */
export const ADMIN_API_KEY = 'test-admin-key-that-is-at-least-32-chars-long';

/** Root directory of the coordinator project (parent of dist/). */
const COORDINATOR_ROOT = join(import.meta.dirname, '..', '..');

/**
 * Entry point for the coordinator process.
 * When built with tsconfig.test.json (rootDir="."), src/ compiles to dist/src/.
 */
const COORDINATOR_DIST = join(COORDINATOR_ROOT, 'dist', 'src', 'index.js');

/**
 * Ed25519 curve order l = 2^252 + 27742317777372353535851937790883648493
 */
const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

// ---------------------------------------------------------------------------
// Port finder
// ---------------------------------------------------------------------------

/** Finds a free TCP port by binding to port 0 then releasing. */
async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.unref();
        srv.listen(0, '127.0.0.1', () => {
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

// ---------------------------------------------------------------------------
// CoordinatorProcess
// ---------------------------------------------------------------------------

export interface CoordinatorOptions {
    /** Explicit port to bind. If omitted, a random free port is chosen. */
    port?: number;
    /** Path to the SQLite database file. Random temp path if omitted. */
    dbPath?: string;
    /** Admin API key. Defaults to ADMIN_API_KEY constant. */
    adminKey?: string;
    /** Mock XMR confirmation delay in ms. Default: 2000. */
    mockConfirmDelay?: number;
    /** Additional environment variable overrides. */
    env?: Record<string, string>;
}

/**
 * Manages a coordinator child process for E2E testing.
 *
 * Usage:
 *   const coord = new CoordinatorProcess({ adminKey: ADMIN_API_KEY });
 *   await coord.start();
 *   // ... run tests against coord.baseUrl ...
 *   await coord.kill();
 */
export class CoordinatorProcess {
    private _port = 0;
    private _proc: ChildProcess | null = null;
    private _started = false;
    private readonly _dbPath: string;
    private readonly _adminKey: string;
    private readonly _mockConfirmDelay: number;
    private readonly _envOverrides: Record<string, string>;
    private readonly _requestedPort: number;

    constructor(options?: CoordinatorOptions) {
        this._requestedPort = options?.port ?? 0;
        const rnd = randomBytes(8).toString('hex');
        this._dbPath = options?.dbPath ?? join(tmpdir(), `coordinator-test-${rnd}.db`);
        this._adminKey = options?.adminKey ?? ADMIN_API_KEY;
        this._mockConfirmDelay = options?.mockConfirmDelay ?? 2000;
        this._envOverrides = options?.env ?? {};
    }

    /** The port the coordinator is listening on (set after start()). */
    get port(): number {
        return this._port;
    }

    /** HTTP base URL for the running coordinator. */
    get baseUrl(): string {
        return `http://localhost:${this._port}`;
    }

    /** Path to the SQLite database used by this instance. */
    get dbPath(): string {
        return this._dbPath;
    }

    /**
     * Start the coordinator process.
     * Picks a random available port if none was specified in the constructor.
     * Resolves once "HTTP server listening" appears in stdout.
     */
    async start(): Promise<void> {
        this._port = this._requestedPort === 0
            ? await getFreePort()
            : this._requestedPort;

        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            PORT: String(this._port),
            DB_PATH: this._dbPath,
            ADMIN_API_KEY: this._adminKey,
            MONERO_MOCK: 'true',
            XMR_MOCK_CONFIRM_DELAY_MS: String(this._mockConfirmDelay),
            SWAP_CONTRACT_ADDRESS: '',
            MOCK_BLOCK_HEIGHT: '1000',
            RATE_LIMIT_DISABLED: 'true',
            CORS_ORIGIN: 'http://localhost:5173,http://localhost:5174,http://test',
            DB_BACKUP_INTERVAL_MS: '0',
            ...this._envOverrides,
        };

        return new Promise<void>((resolve, reject) => {
            this._proc = spawn('node', [COORDINATOR_DIST], {
                env,
                cwd: COORDINATOR_ROOT,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    reject(new Error('Coordinator did not start within 15 seconds'));
                }
            }, 15_000);

            let stderrBuf = '';

            this._proc.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString();
                if (!resolved && (text.includes('HTTP server listening') || text.includes('listening on'))) {
                    resolved = true;
                    clearTimeout(timeout);
                    this._started = true;
                    resolve();
                }
            });

            this._proc.stderr?.on('data', (chunk: Buffer) => {
                stderrBuf += chunk.toString();
                if (!resolved && (stderrBuf.includes('Fatal error') || stderrBuf.includes('ERR_'))) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(new Error(`Coordinator failed to start: ${stderrBuf}`));
                }
            });

            this._proc.on('error', (err: Error) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(err);
                }
            });

            this._proc.on('exit', (code: number | null) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    reject(new Error(`Coordinator exited prematurely with code ${code}.\nstderr: ${stderrBuf}`));
                }
            });
        });
    }

    /** Send SIGTERM and wait for process to exit. Falls back to SIGKILL after 3s. */
    async kill(): Promise<void> {
        const proc = this._proc;
        if (!proc) return;

        this._proc = null;
        this._started = false;

        if (proc.exitCode !== null) return;

        return new Promise<void>((resolve) => {
            const forceKillTimer = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    /* already dead */
                }
                resolve();
            }, 3_000);

            proc.on('exit', () => {
                clearTimeout(forceKillTimer);
                resolve();
            });

            proc.kill('SIGTERM');
        });
    }

    /** Kill and re-start the coordinator, preserving the same DB path for persistence testing. */
    async restart(): Promise<void> {
        await this.kill();
        // Pick a fresh port since the old one may be in TIME_WAIT
        this._port = 0;
        await this.start();
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

/**
 * Typed HTTP client wrapping all coordinator API endpoints.
 * Uses the global fetch API (Node 18+).
 */
export class SwapApiClient {
    constructor(
        private readonly baseUrl: string,
        private readonly apiKey: string = ADMIN_API_KEY,
    ) {}

    // -- Health --

    /** GET /api/health */
    async health(): Promise<IApiResult> {
        return this.request('GET', '/api/health');
    }

    // -- Swap CRUD --

    /** POST /api/swaps -- create a new swap. Requires admin auth. */
    async createSwap(params: {
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

    /** GET /api/swaps -- paginated list. */
    async listSwaps(page = 1, limit = 20): Promise<IApiResult> {
        return this.request('GET', `/api/swaps?page=${page}&limit=${limit}`);
    }

    /** GET /api/swaps/:id -- single swap with history. */
    async getSwap(swapId: string): Promise<IApiResult> {
        return this.request('GET', `/api/swaps/${encodeURIComponent(swapId)}`);
    }

    // -- Swap actions --

    /** POST /api/swaps/:id/take -- returns { claim_token }. */
    async takeSwap(swapId: string, opnetTxId: string): Promise<IApiResult> {
        return this.request('POST', `/api/swaps/${encodeURIComponent(swapId)}/take`, { opnetTxId });
    }

    /** POST /api/swaps/:id/secret -- validates SHA-256(secret) == hash_lock. */
    async submitSecret(swapId: string, secret: string, aliceViewKey?: string): Promise<IApiResult> {
        const body: Record<string, string> = { secret };
        if (aliceViewKey !== undefined) body['aliceViewKey'] = aliceViewKey;
        return this.request('POST', `/api/swaps/${encodeURIComponent(swapId)}/secret`, body);
    }

    /** POST /api/swaps/:id/keys -- submit Bob's Ed25519 key material + Schnorr proof. */
    async submitKeys(
        swapId: string,
        keys: {
            bobEd25519PubKey: string;
            bobViewKey: string;
            bobKeyProof: string;
            bobSpendKey?: string;
        },
    ): Promise<IApiResult> {
        return this.request('POST', `/api/swaps/${encodeURIComponent(swapId)}/keys`, keys);
    }

    // -- Admin --

    /** PUT /api/admin/swaps/:id -- test-only admin state machine driver. */
    async adminUpdate(swapId: string, fields: Record<string, string | number | null>): Promise<IApiResult> {
        return this.request('PUT', `/api/admin/swaps/${encodeURIComponent(swapId)}`, fields, true);
    }

    // -- Fee address --

    /** GET /api/fee-address */
    async getFeeAddress(): Promise<IApiResult> {
        return this.request('GET', '/api/fee-address');
    }

    /** PUT /api/fee-address -- requires admin auth. */
    async setFeeAddress(address: string): Promise<IApiResult> {
        return this.request('PUT', '/api/fee-address', { address }, true);
    }

    // -- Raw request for edge-case testing --

    /** Issue an arbitrary HTTP request to the coordinator. */
    async raw(method: string, path: string, body?: unknown, admin = false): Promise<IApiResult> {
        return this.request(method, path, body, admin);
    }

    // -- Internal --

    private async request(
        method: string,
        path: string,
        body?: unknown,
        admin = false,
    ): Promise<IApiResult> {
        const url = `${this.baseUrl}${path}`;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            Accept: 'application/json',
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
            parsed = {
                success: false,
                data: null,
                error: { code: 'PARSE_ERROR', message: text, retryable: false },
            };
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

/**
 * WebSocket client wrapper for testing coordinator WS broadcasts.
 *
 * On connect, the coordinator sends an `active_swaps` message.
 * After subscribing with a valid claim_token, the client receives
 * `swap_update` and `preimage_ready` messages.
 */
export class WsClient {
    private ws: WebSocket | null = null;
    public readonly messages: IWsMessage[] = [];
    private messageResolvers: Array<(msg: IWsMessage) => void> = [];

    constructor(private readonly baseUrl: string) {}

    /** Connect to the WebSocket server. Resolves when the connection is open. */
    async connect(): Promise<void> {
        const wsUrl = this.baseUrl.replace('http://', 'ws://');
        return new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('WebSocket connect timeout (5s)'));
            }, 5_000);

            ws.on('open', () => {
                clearTimeout(timeout);
                this.ws = ws;
                resolve();
            });

            ws.on('error', (err: Error) => {
                clearTimeout(timeout);
                reject(err);
            });

            ws.on('message', (raw: Buffer | string) => {
                try {
                    const msg = JSON.parse(
                        typeof raw === 'string' ? raw : raw.toString(),
                    ) as IWsMessage;
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

    /** Send a JSON message over the WebSocket. */
    send(data: object): void {
        if (!this.ws) throw new Error('WebSocket not connected');
        this.ws.send(JSON.stringify(data));
    }

    /** Subscribe to a swap with a claim token. */
    subscribe(swapId: string, claimToken?: string): void {
        this.send({ type: 'subscribe', swapId, claimToken });
    }

    /**
     * Wait for a message of the given type.
     * Returns immediately if a matching message was already received (and not yet consumed).
     */
    async waitForMessage(type: string, timeout = 10_000): Promise<IWsMessage> {
        // Check already-received messages
        const idx = this.messages.findIndex((m) => m.type === type);
        if (idx !== -1) {
            return this.messages[idx]!;
        }

        return new Promise<IWsMessage>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timed out waiting for WS message type "${type}" after ${timeout}ms`));
            }, timeout);

            const check = (msg: IWsMessage): void => {
                if (msg.type === type) {
                    clearTimeout(timer);
                    resolve(msg);
                } else {
                    // Re-queue ourselves
                    this.messageResolvers.push(check);
                }
            };
            this.messageResolvers.push(check);
        });
    }

    /** Wait for a preimage_ready message and return the preimage string. */
    async waitForPreimage(timeout = 15_000): Promise<string> {
        const msg = await this.waitForMessage('preimage_ready', timeout);
        const data = msg.data as { preimage?: string };
        return data.preimage ?? '';
    }

    /** Return messages of a specific type. */
    getMessages(type: string): IWsMessage[] {
        return this.messages.filter((m) => m.type === type);
    }

    /** Clear all collected messages. */
    clearMessages(): void {
        this.messages.length = 0;
    }

    /** Close the WebSocket connection. */
    close(): void {
        this.ws?.close();
        this.ws = null;
    }
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/** Generates a random 32-byte preimage and its SHA-256 hash lock (both as hex strings). */
export function generatePreimageAndHash(): { preimage: string; hashLock: string } {
    const preimageBytes = randomBytes(32);
    const preimage = preimageBytes.toString('hex');
    const hashLock = createHash('sha256').update(preimageBytes).digest('hex');
    return { preimage, hashLock };
}

/**
 * Generate Ed25519 Bob key material with a valid Schnorr proof of knowledge.
 *
 * Schnorr protocol:
 *   challenge = SHA-256("bob-key-proof:" + swapId)
 *   k = random scalar
 *   R = k * G
 *   e = SHA-256(R || P || challenge) mod l
 *   s = (k + e * priv) mod l
 *   proof = hex(R || s) (128 hex chars / 64 bytes)
 */
export function generateBobKeyMaterial(swapId: string): {
    bobPubKey: string;
    bobViewKey: string;
    bobKeyProof: string;
    bobSpendKey: string;
} {
    // Generate Ed25519 keypair
    const privKey = ed25519.utils.randomSecretKey();
    const pubKeyBytes = ed25519.getPublicKey(privKey);
    const bobPubKey = Buffer.from(pubKeyBytes).toString('hex');

    // Generate a separate view key
    const viewPriv = ed25519.utils.randomSecretKey();
    const bobViewKey = Buffer.from(ed25519.getPublicKey(viewPriv)).toString('hex');

    // Spend key (for split-key mode)
    const bobSpendKey = Buffer.from(privKey).toString('hex');

    // --- Schnorr proof ---
    const challenge = createHash('sha256')
        .update(`bob-key-proof:${swapId}`)
        .digest();

    // k: random nonce scalar
    const kBytes = randomBytes(32);
    const kBig = bytesToScalar(kBytes);

    // R = k * G
    const rPoint = ed25519.Point.BASE.multiply(kBig === 0n ? 1n : kBig);
    const rBytes = rPoint.toBytes();

    // e = SHA-256(R || P || challenge) mod l
    const eHash = createHash('sha256')
        .update(rBytes)
        .update(pubKeyBytes)
        .update(challenge)
        .digest();
    const eBig = bytesToScalar(eHash);

    // Private scalar -- Ed25519 "clamped" from SHA-512(seed)
    const privScalar = getEd25519PrivateScalar(privKey);

    // s = (k + e * priv) mod l
    const sBig = mod(kBig + eBig * privScalar, ED25519_ORDER);
    const sBytes = scalarToBytes(sBig);

    const bobKeyProof = Buffer.from(rBytes).toString('hex') + Buffer.from(sBytes).toString('hex');

    return { bobPubKey, bobViewKey, bobKeyProof, bobSpendKey };
}

// ---------------------------------------------------------------------------
// Swap params factory
// ---------------------------------------------------------------------------

let swapCounter = 100_000;

/**
 * Generate valid swap creation params with a unique numeric swap_id.
 * Returns both the params and the preimage (kept for test assertions, not sent to API).
 */
export function generateSwapParams(label = ''): {
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
    void label; // used for debug identification; not sent to API
    swapCounter++;
    const { preimage, hashLock } = generatePreimageAndHash();
    return {
        params: {
            swap_id: String(swapCounter),
            hash_lock: hashLock,
            refund_block: 999_999,
            moto_amount: '100000000000000000000',
            xmr_amount: '1000000000000', // 1 XMR in piconero
            depositor: 'opt1sqtest' + randomBytes(16).toString('hex'),
        },
        preimage,
    };
}

/**
 * Convenience alias matching the user's spec naming convention.
 * Same as generateSwapParams but accepts a string|number swap ID.
 */
export function makeSwapParams(swapId?: string | number): {
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
    if (swapId !== undefined) {
        const { preimage, hashLock } = generatePreimageAndHash();
        return {
            params: {
                swap_id: String(swapId),
                hash_lock: hashLock,
                refund_block: 999_999,
                moto_amount: '100000000000000000000',
                xmr_amount: '1000000000000',
                depositor: 'opt1sqtest' + randomBytes(16).toString('hex'),
            },
            preimage,
        };
    }
    return generateSwapParams();
}

/** Returns a unique numeric swap ID string (monotonically incrementing). */
export function uniqueId(): string {
    swapCounter++;
    return String(swapCounter);
}

/** Reset the swap counter (useful between test suites). */
export function resetSwapCounter(): void {
    swapCounter = 100_000;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Promise-based delay. */
export function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Alias for wait(). */
export const sleep = wait;

// ---------------------------------------------------------------------------
// TimingRecorder
// ---------------------------------------------------------------------------

interface ITimingEntry {
    operation: string;
    durationMs: number;
}

/** Records operation timings and prints a summary table at the end of the test run. */
export class TimingRecorder {
    private readonly entries: ITimingEntry[] = [];

    record(operation: string, durationMs: number): void {
        this.entries.push({ operation, durationMs });
    }

    async time<T>(operation: string, fn: () => Promise<T>): Promise<T> {
        const start = performance.now();
        const result = await fn();
        this.record(operation, performance.now() - start);
        return result;
    }

    printSummary(): void {
        if (this.entries.length === 0) return;

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
        console.log(
            'Operation'.padEnd(30) +
            'Avg(ms)'.padStart(10) +
            'Min(ms)'.padStart(10) +
            'Max(ms)'.padStart(10) +
            'Count'.padStart(8),
        );
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
// Internal scalar math helpers
// ---------------------------------------------------------------------------

/** Convert arbitrary-length bytes to a scalar mod l (little-endian). */
function bytesToScalar(bytes: Uint8Array | Buffer): bigint {
    let n = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        n = (n << 8n) | BigInt(bytes[i]!);
    }
    return mod(n, ED25519_ORDER);
}

/** Modular reduction (always positive). */
function mod(a: bigint, m: bigint): bigint {
    const r = a % m;
    return r < 0n ? r + m : r;
}

/** Convert a scalar to 32-byte little-endian Uint8Array. */
function scalarToBytes(s: bigint): Uint8Array {
    const out = new Uint8Array(32);
    let v = s;
    for (let i = 0; i < 32; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

/**
 * Derive the Ed25519 private scalar from a 32-byte seed.
 * Per RFC 8032: SHA-512(seed), take lower 32 bytes, clamp.
 */
function getEd25519PrivateScalar(seed: Uint8Array): bigint {
    const h = createHash('sha512').update(seed).digest();
    h[0]! &= 248;
    h[31]! &= 127;
    h[31]! |= 64;
    return bytesToScalar(h.subarray(0, 32));
}
