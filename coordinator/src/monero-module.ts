/**
 * Monero module — preimage/hashLock generation (real SHA-256) + IMoneroService
 * with MockMoneroService (timer-based) and RealMoneroService (monero-wallet-rpc).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type IPreimageResult, SwapStatus, FEE_BPS } from './types.js';
import type { StorageService } from './storage.js';
import type { SwapStateMachine } from './state-machine.js';
import type { SwapWebSocketServer } from './websocket.js';

const XMR_REQUIRED_CONFIRMATIONS = 10;

// ---------------------------------------------------------------------------
// Fee address management (unchanged)
// ---------------------------------------------------------------------------

let xmrFeeAddress: string = process.env['XMR_FEE_ADDRESS'] ?? '';

export function getFeeAddress(): string {
    return xmrFeeAddress;
}

export function setFeeAddress(address: string): void {
    const trimmed = address.trim();
    if (trimmed.length === 0) {
        throw new Error('Fee address must not be empty');
    }
    // Basic Monero address format validation:
    // Mainnet: starts with '4' (95 chars) or '8' (95 chars subaddress)
    // Stagenet/Testnet: starts with '5' or '7' (95 chars)
    if (trimmed.length !== 95 && trimmed.length !== 106) {
        throw new Error('Invalid Monero address length (expected 95 or 106 characters)');
    }
    if (!/^[45789]/.test(trimmed)) {
        throw new Error('Invalid Monero address prefix (expected 4, 5, 7, 8, or 9)');
    }
    console.log(`[Monero] Fee address updated: ${trimmed.slice(0, 12)}...${trimmed.slice(-6)}`);
    xmrFeeAddress = trimmed;
}

// ---------------------------------------------------------------------------
// Preimage / hash-lock utilities (unchanged — real crypto)
// ---------------------------------------------------------------------------

export function generatePreimage(): IPreimageResult {
    const preimageBytes = randomBytes(32);
    const preimage = preimageBytes.toString('hex');
    const hashLockBytes = createHash('sha256').update(preimageBytes).digest();
    const hashLock = hashLockBytes.toString('hex');
    return { preimage, hashLock };
}

export function hashPreimage(preimage: string): string {
    const preimageBytes = hexToUint8Array(preimage);
    const hash = createHash('sha256').update(preimageBytes).digest();
    return hash.toString('hex');
}

export function verifyPreimage(preimage: string, expectedHashLock: string): boolean {
    const computed = hashPreimage(preimage);
    const expected = expectedHashLock.toLowerCase();
    if (computed.length !== expected.length) return false;
    return timingSafeEqual(
        Uint8Array.from(hexToUint8Array(computed)),
        Uint8Array.from(hexToUint8Array(expected)),
    );
}

function hexToUint8Array(hex: string): Uint8Array {
    const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        const byte = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
        bytes[i] = byte;
    }
    return bytes;
}

// ---------------------------------------------------------------------------
// notifyXmrConfirmed — internal orchestration (unchanged)
// ---------------------------------------------------------------------------

export function notifyXmrConfirmed(
    swapId: string,
    confirmations: number,
    storage: StorageService,
    stateMachine: SwapStateMachine,
    wsServer: SwapWebSocketServer,
): void {
    const swap = storage.getSwap(swapId);
    if (!swap) {
        console.error(`[Monero] notifyXmrConfirmed: swap ${swapId} not found`);
        return;
    }

    if (swap.status !== SwapStatus.XMR_LOCKING) {
        console.warn(
            `[Monero] notifyXmrConfirmed: swap ${swapId} is in state ${swap.status}, expected XMR_LOCKING`,
        );
        return;
    }

    if (confirmations < XMR_REQUIRED_CONFIRMATIONS) {
        console.warn(
            `[Monero] notifyXmrConfirmed: only ${confirmations} confirmations for swap ${swapId}, need ${XMR_REQUIRED_CONFIRMATIONS}`,
        );
        return;
    }

    if (!swap.preimage) {
        console.error(
            `[Monero] notifyXmrConfirmed: no preimage stored for swap ${swapId} — cannot unlock`,
        );
        return;
    }

    if (!verifyPreimage(swap.preimage, swap.hash_lock)) {
        console.error(
            `[Monero] notifyXmrConfirmed: preimage integrity check failed for swap ${swapId}`,
        );
        return;
    }

    try {
        const withConfs = storage.updateSwap(swapId, {
            xmr_lock_confirmations: confirmations,
        });
        stateMachine.validate(withConfs, SwapStatus.XMR_LOCKED);
        const updated = storage.updateSwap(
            swapId,
            { status: SwapStatus.XMR_LOCKED },
            SwapStatus.XMR_LOCKING,
            `XMR lock confirmed with ${confirmations} confirmations`,
        );
        stateMachine.notifyTransition(updated, SwapStatus.XMR_LOCKING, SwapStatus.XMR_LOCKED);

        wsServer.broadcastPreimageReady(swapId, swap.preimage);

        const feeAddr = xmrFeeAddress.length > 0
            ? `${xmrFeeAddress.slice(0, 12)}...`
            : '(not configured)';
        console.log(
            `[Monero] Swap ${swapId} transitioned to XMR_LOCKED; preimage broadcast via WebSocket` +
            ` (fee: ${FEE_BPS}bps — Alice gets ${swap.xmr_amount}, platform keeps ${swap.xmr_fee} → ${feeAddr})`,
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[Monero] notifyXmrConfirmed failed for swap ${swapId}: ${message}`);
    }
}

// ---------------------------------------------------------------------------
// IMoneroService interface + implementations
// ---------------------------------------------------------------------------

/** Callback invoked when XMR lock reaches required confirmations. */
export type OnConfirmedCallback = (confirmations: number, txId: string) => void;

/** Callback invoked on each confirmation progress update. */
export type OnProgressCallback = (confirmations: number) => void;

/** Result of creating a Monero lock address. */
export interface ILockAddressResult {
    readonly address: string;
    readonly subaddrIndex: number;
}

/** Service interface for Monero wallet operations. */
export interface IMoneroService {
    createLockAddress(swapId: string): Promise<ILockAddressResult>;
    startMonitoring(
        swapId: string,
        address: string,
        expectedAmount: bigint,
        onConfirmed: OnConfirmedCallback,
        onProgress?: OnProgressCallback,
        subaddrIndex?: number,
    ): void;
    stopMonitoring(swapId: string): void;
    stopAll(): void;
}

// ---------------------------------------------------------------------------
// MockMoneroService — timer-based, no real XMR needed
// ---------------------------------------------------------------------------

const XMR_MOCK_CONFIRM_DELAY_MS = parseInt(
    process.env['XMR_MOCK_CONFIRM_DELAY_MS'] ?? '15000',
    10,
);

export class MockMoneroService implements IMoneroService {
    private readonly timers = new Map<string, NodeJS.Timeout[]>();
    private counter = 0;

    public createLockAddress(swapId: string): Promise<ILockAddressResult> {
        this.counter++;
        const fakeAddr =
            '5' +
            randomBytes(46).toString('hex').slice(0, 93) +
            this.counter.toString().padStart(2, '0');
        console.log(
            `[MockMonero] createLockAddress(${swapId}) → ${fakeAddr.slice(0, 12)}...${fakeAddr.slice(-6)}`,
        );
        return Promise.resolve({ address: fakeAddr, subaddrIndex: this.counter });
    }

    public startMonitoring(
        swapId: string,
        _address: string,
        _expectedAmount: bigint,
        onConfirmed: OnConfirmedCallback,
        onProgress?: OnProgressCallback,
        _subaddrIndex?: number,
    ): void {
        console.log(
            `[MockMonero] startMonitoring(${swapId}) — will auto-confirm in ${XMR_MOCK_CONFIRM_DELAY_MS}ms`,
        );

        const timerList: NodeJS.Timeout[] = [];

        // Progress at ~33% and ~66%
        const t1 = setTimeout(() => {
            console.log(`[MockMonero] Swap ${swapId}: 3 confirmations`);
            onProgress?.(3);
        }, Math.round(XMR_MOCK_CONFIRM_DELAY_MS * 0.33));
        timerList.push(t1);

        const t2 = setTimeout(() => {
            console.log(`[MockMonero] Swap ${swapId}: 7 confirmations`);
            onProgress?.(7);
        }, Math.round(XMR_MOCK_CONFIRM_DELAY_MS * 0.66));
        timerList.push(t2);

        // Full confirmation
        const t3 = setTimeout(() => {
            const fakeTxId = randomBytes(32).toString('hex');
            console.log(
                `[MockMonero] Swap ${swapId}: 10 confirmations — confirmed (fakeTx: ${fakeTxId.slice(0, 16)}...)`,
            );
            onConfirmed(XMR_REQUIRED_CONFIRMATIONS, fakeTxId);
            this.timers.delete(swapId);
        }, XMR_MOCK_CONFIRM_DELAY_MS);
        timerList.push(t3);

        this.timers.set(swapId, timerList);
    }

    public stopMonitoring(swapId: string): void {
        const timerList = this.timers.get(swapId);
        if (timerList) {
            for (const t of timerList) clearTimeout(t);
            this.timers.delete(swapId);
            console.log(`[MockMonero] stopMonitoring(${swapId})`);
        }
    }

    public stopAll(): void {
        for (const [swapId, timerList] of this.timers) {
            for (const t of timerList) clearTimeout(t);
            console.log(`[MockMonero] stopAll: cleared ${swapId}`);
        }
        this.timers.clear();
    }
}

// ---------------------------------------------------------------------------
// RealMoneroService — monero-wallet-rpc integration
// ---------------------------------------------------------------------------

const XMR_POLL_INTERVAL_MS = parseInt(
    process.env['XMR_POLL_INTERVAL_MS'] ?? '30000',
    10,
);

interface ITransferEntry {
    readonly confirmations?: number;
    readonly txid?: string;
    readonly amount?: number;
    readonly address?: string;
    readonly subaddr_index?: { readonly major: number; readonly minor: number };
}

interface IGetTransfersResponse {
    readonly result?: {
        readonly pool?: ITransferEntry[];
        readonly in?: ITransferEntry[];
    };
}

export class RealMoneroService implements IMoneroService {
    private readonly rpcUrl: string;
    private readonly rpcUser: string;
    private readonly rpcPass: string;
    private readonly pollTimers = new Map<string, NodeJS.Timeout>();

    /** Maps swapId → subaddress index for filtering incoming transfers. */
    private readonly subaddrIndices = new Map<string, number>();

    public constructor() {
        this.rpcUrl = process.env['XMR_WALLET_RPC_URL'] ?? 'http://localhost:18082/json_rpc';
        this.rpcUser = process.env['XMR_WALLET_RPC_USER'] ?? '';
        this.rpcPass = process.env['XMR_WALLET_RPC_PASS'] ?? '';
        console.log(`[RealMonero] Configured RPC URL: ${this.rpcUrl}`);

        // Warn if credentials are sent over plaintext HTTP to a remote host
        if (this.rpcUser.length > 0 && this.rpcUrl.startsWith('http://')) {
            const urlHost = new URL(this.rpcUrl).hostname;
            if (urlHost !== 'localhost' && urlHost !== '127.0.0.1' && urlHost !== '::1') {
                console.error(
                    `[RealMonero] *** SECURITY WARNING *** RPC credentials sent over plaintext HTTP to remote host ${urlHost}. ` +
                    `Use HTTPS or connect via localhost/SSH tunnel.`,
                );
            }
        }
    }

    public async createLockAddress(swapId: string): Promise<ILockAddressResult> {
        const response = await this.rpcCall<{
            result: { address: string; address_index: number };
        }>('create_address', { account_index: 0, label: `swap-${swapId}` });

        const addr = response.result.address;
        const addrIndex = response.result.address_index;
        this.subaddrIndices.set(swapId, addrIndex);
        console.log(
            `[RealMonero] createLockAddress(${swapId}) → ${addr.slice(0, 12)}...${addr.slice(-6)} (subaddr_index: ${addrIndex})`,
        );
        return { address: addr, subaddrIndex: addrIndex };
    }

    public startMonitoring(
        swapId: string,
        address: string,
        expectedAmount: bigint,
        onConfirmed: OnConfirmedCallback,
        onProgress?: OnProgressCallback,
        recoverySubaddrIndex?: number,
    ): void {
        console.log(
            `[RealMonero] startMonitoring(${swapId}) — polling every ${XMR_POLL_INTERVAL_MS}ms, expecting ${expectedAmount} piconero`,
        );

        // Resolve subaddress index: prefer in-memory (from createLockAddress), fall back to persisted value
        if (recoverySubaddrIndex !== undefined && !this.subaddrIndices.has(swapId)) {
            this.subaddrIndices.set(swapId, recoverySubaddrIndex);
        }
        const subaddrIndex = this.subaddrIndices.get(swapId);

        const poll = async (): Promise<void> => {
            try {
                // Filter by subaddress index if known — only shows transfers
                // to this specific lock address, not the entire wallet.
                const subaddrFilter = subaddrIndex !== undefined ? [subaddrIndex] : [];
                const transfers = await this.rpcCall<IGetTransfersResponse>('get_transfers', {
                    in: true,
                    pool: true,
                    filter_by_height: false,
                    subaddr_indices: subaddrFilter,
                });

                const allTxs: ITransferEntry[] = [
                    ...(transfers.result?.pool ?? []),
                    ...(transfers.result?.in ?? []),
                ];

                // Only consider transfers that:
                // 1. Match the expected amount (>= for overpayment tolerance)
                // 2. Are sent to the correct lock address (destination validation)
                let bestConfs = 0;
                let bestTxId = '';

                for (const tx of allTxs) {
                    // Validate destination address matches the per-swap lock address.
                    // MANDATORY: reject if address field is missing or doesn't match.
                    if (!tx.address || tx.address !== address) {
                        continue; // Missing or wrong destination — reject
                    }

                    // Validate subaddress index if available
                    if (subaddrIndex !== undefined && tx.subaddr_index) {
                        if (tx.subaddr_index.minor !== subaddrIndex) {
                            continue; // Wrong subaddress — reject
                        }
                    }

                    const txAmount = BigInt(tx.amount ?? 0);
                    if (txAmount < expectedAmount) {
                        continue; // Reject underpayment
                    }
                    const confs = tx.confirmations ?? 0;
                    if (confs > bestConfs) {
                        bestConfs = confs;
                        bestTxId = tx.txid ?? '';
                    }
                }

                if (bestConfs > 0) {
                    onProgress?.(bestConfs);
                    console.log(
                        `[RealMonero] Swap ${swapId}: ${bestConfs} confirmations (addr: ${address.slice(0, 8)}...)`,
                    );
                }

                if (bestConfs >= XMR_REQUIRED_CONFIRMATIONS) {
                    onConfirmed(bestConfs, bestTxId);
                    this.stopMonitoring(swapId);
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Unknown error';
                console.error(`[RealMonero] Poll error for swap ${swapId}: ${msg}`);
            }
        };

        void poll();
        const timer = setInterval(() => void poll(), XMR_POLL_INTERVAL_MS);
        this.pollTimers.set(swapId, timer);
    }

    public stopMonitoring(swapId: string): void {
        const timer = this.pollTimers.get(swapId);
        if (timer) {
            clearInterval(timer);
            this.pollTimers.delete(swapId);
            this.subaddrIndices.delete(swapId);
            console.log(`[RealMonero] stopMonitoring(${swapId})`);
        }
    }

    public stopAll(): void {
        for (const [swapId, timer] of this.pollTimers) {
            clearInterval(timer);
            console.log(`[RealMonero] stopAll: cleared ${swapId}`);
        }
        this.pollTimers.clear();
        this.subaddrIndices.clear();
    }

    private async rpcCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.rpcUser.length > 0) {
            const credentials = `${this.rpcUser}:${this.rpcPass}`;
            const encoded = btoa(credentials);
            headers['Authorization'] = `Basic ${encoded}`;
        }

        const res = await fetch(this.rpcUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: '0',
                method,
                params,
            }),
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
            throw new Error(`Monero RPC ${method} failed: HTTP ${res.status}`);
        }

        const json = (await res.json()) as Record<string, unknown>;
        if (json['error'] !== undefined && json['error'] !== null) {
            const rpcErr = json['error'] as { code?: number; message?: string };
            throw new Error(`Monero RPC ${method} error: ${rpcErr.message ?? 'unknown'} (code: ${rpcErr.code ?? -1})`);
        }

        return json as T;
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMoneroService(): IMoneroService {
    const useMock = (process.env['MONERO_MOCK'] ?? 'false').toLowerCase() === 'true';
    if (useMock) {
        if (process.env['NODE_ENV'] === 'production') {
            throw new Error('MONERO_MOCK=true is forbidden in production (NODE_ENV=production)');
        }
        console.warn('[Monero] *** MOCK MODE *** Using MockMoneroService (MONERO_MOCK=true)');
        return new MockMoneroService();
    }
    console.log('[Monero] Using RealMoneroService');
    return new RealMoneroService();
}
