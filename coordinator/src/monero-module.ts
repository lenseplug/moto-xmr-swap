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
// Monero address validation
// ---------------------------------------------------------------------------

/** Valid Base58 characters used by Monero (no 0, O, I, l). */
const MONERO_BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MONERO_BASE58_SET = new Set(MONERO_BASE58_ALPHABET);

interface IAddrType {
    readonly prefix: string;
    readonly length: number;
}

/** Valid address types with their expected lengths and prefix chars. */
const MONERO_ADDR_TYPES: ReadonlyArray<IAddrType> = [
    // Mainnet
    { prefix: '4', length: 95 },  // standard
    { prefix: '8', length: 95 },  // subaddress
    { prefix: '4', length: 106 }, // integrated
    // Stagenet
    { prefix: '5', length: 95 },
    { prefix: '7', length: 95 },
    { prefix: '5', length: 106 },
    // Testnet
    { prefix: '9', length: 95 },
    { prefix: 'B', length: 95 },
    { prefix: 'A', length: 106 },
];

/**
 * Validates a Monero address format.
 * Checks: length, prefix, Base58 character set.
 *
 * @param address - The Monero address string.
 * @returns null if valid, error string if invalid.
 */
export function validateMoneroAddress(address: string): string | null {
    if (address.length === 0) {
        return 'Address must not be empty';
    }

    // Check length: 95 (standard/subaddress) or 106 (integrated)
    if (address.length !== 95 && address.length !== 106) {
        return `Invalid address length: ${address.length} (expected 95 or 106)`;
    }

    // Check Base58 character set
    for (let i = 0; i < address.length; i++) {
        if (!MONERO_BASE58_SET.has(address[i] as string)) {
            return `Invalid character '${address[i]}' at position ${i} — not valid Monero Base58`;
        }
    }

    // Check prefix matches a known network type
    const firstChar = address[0];
    const validPrefix = MONERO_ADDR_TYPES.some(
        (t) => t.prefix === firstChar && t.length === address.length,
    );

    if (!validPrefix) {
        return `Invalid address prefix '${firstChar}' for length ${address.length}`;
    }

    return null;
}

// ---------------------------------------------------------------------------
// Fee address management
// ---------------------------------------------------------------------------

let xmrFeeAddress: string = process.env['XMR_FEE_ADDRESS'] ?? '';

export function getFeeAddress(): string {
    return xmrFeeAddress;
}

export function setFeeAddress(address: string): void {
    const trimmed = address.trim();
    const error = validateMoneroAddress(trimmed);
    if (error !== null) {
        throw new Error(`Invalid Monero fee address: ${error}`);
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

/** Result of transferring XMR to a lock address. */
export interface ITransferResult {
    readonly ok: boolean;
    readonly txId: string | null;
    readonly error: string | null;
}

/** Result of sweeping XMR from a shared lock address. */
export interface ISweepResult {
    readonly ok: boolean;
    readonly txId: string | null;
    readonly feeAmount: string;
    readonly aliceAmount: string;
    readonly error: string | null;
}

/** Service interface for Monero wallet operations. */
export interface IMoneroService {
    /** Whether a sweep is currently in progress (wallet-rpc exclusivity). */
    readonly sweepActive: boolean;
    createLockAddress(swapId: string): Promise<ILockAddressResult>;
    startMonitoring(
        swapId: string,
        address: string,
        expectedAmount: bigint,
        onConfirmed: OnConfirmedCallback,
        onProgress?: OnProgressCallback,
        subaddrIndex?: number,
        lockTxId?: string,
        splitKeyInfo?: { viewKeyHex: string; restoreHeight?: number },
    ): void;
    stopMonitoring(swapId: string): void;
    stopAll(): void;

    /**
     * Checks if monero-wallet-rpc is reachable.
     * @returns null if healthy, error string if unreachable.
     */
    healthCheck(): Promise<string | null>;

    /**
     * Transfers XMR from the coordinator's wallet to a lock address.
     * This is how the coordinator provides XMR liquidity for MOTO→XMR swaps.
     *
     * @param swapId - The swap ID (for logging).
     * @param address - The lock address to send XMR to.
     * @param amountPiconero - The amount to send in piconero.
     */
    transferToLockAddress(
        swapId: string,
        address: string,
        amountPiconero: bigint,
    ): Promise<ITransferResult>;

    /**
     * Sweeps XMR from a completed swap's shared lock address.
     * Imports the reconstructed spend key, sweeps the balance,
     * and splits it: fee → fee wallet, remainder → Alice's XMR address.
     *
     * @param swapId - The swap ID (for logging).
     * @param spendKeyHex - The reconstructed full spend key (s_alice + s_bob), 64 hex chars.
     * @param viewKeyHex - The reconstructed full view key (v_alice + v_bob), 64 hex chars.
     * @param lockAddress - The shared XMR lock address to sweep from.
     * @param aliceAmountPiconero - The exact amount Alice should receive in piconero.
     * @param aliceAddress - Alice's XMR address (optional — if not set, all goes to fee wallet).
     */
    sweepToFeeWallet(
        swapId: string,
        spendKeyHex: string,
        viewKeyHex: string,
        lockAddress: string,
        aliceAmountPiconero: bigint,
        aliceAddress?: string,
    ): Promise<ISweepResult>;
}

// ---------------------------------------------------------------------------
// MockMoneroService — timer-based, no real XMR needed
// ---------------------------------------------------------------------------

const XMR_MOCK_CONFIRM_DELAY_MS = parseInt(
    process.env['XMR_MOCK_CONFIRM_DELAY_MS'] ?? '15000',
    10,
);

/** Artificial delay for mock sweeps (ms). Set via XMR_MOCK_SWEEP_DELAY_MS env. */
const XMR_MOCK_SWEEP_DELAY_MS = parseInt(
    process.env['XMR_MOCK_SWEEP_DELAY_MS'] ?? '500',
    10,
);

export class MockMoneroService implements IMoneroService {
    private readonly timers = new Map<string, NodeJS.Timeout[]>();
    private counter = 0;
    private _sweepActive = false;

    public get sweepActive(): boolean {
        return this._sweepActive;
    }

    public createLockAddress(swapId: string): Promise<ILockAddressResult> {
        this.counter++;
        // Generate a valid Monero Base58 address (stagenet, 95 chars, prefix '5')
        const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        const rndBytes = randomBytes(94);
        let body = '';
        for (let i = 0; i < 94; i++) {
            body += base58Chars[(rndBytes[i] as number) % base58Chars.length];
        }
        const fakeAddr = '5' + body; // 95 chars total
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
        _lockTxId?: string,
        _splitKeyInfo?: { viewKeyHex: string; restoreHeight?: number },
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

    public healthCheck(): Promise<string | null> {
        console.log('[MockMonero] healthCheck: mock mode — always healthy');
        return Promise.resolve(null);
    }

    public transferToLockAddress(
        swapId: string,
        _address: string,
        amountPiconero: bigint,
    ): Promise<ITransferResult> {
        const fakeTxId = randomBytes(32).toString('hex');
        console.log(
            `[MockMonero] transferToLockAddress(${swapId}): ${amountPiconero} piconero (fakeTx: ${fakeTxId.slice(0, 16)}...)`,
        );
        return Promise.resolve({ ok: true, txId: fakeTxId, error: null });
    }

    public async sweepToFeeWallet(
        swapId: string,
        _spendKeyHex: string,
        _viewKeyHex: string,
        _lockAddress: string,
        aliceAmountPiconero: bigint,
        aliceAddress?: string,
    ): Promise<ISweepResult> {
        this._sweepActive = true;
        try {
            const fakeTxId = randomBytes(32).toString('hex');
            console.log(
                `[MockMonero] sweepToFeeWallet(${swapId}): alice=${aliceAmountPiconero} piconero → ${aliceAddress ?? 'fee wallet'} (fakeTx: ${fakeTxId.slice(0, 16)}...)`,
            );
            // Artificial delay for queue testing
            if (XMR_MOCK_SWEEP_DELAY_MS > 0) {
                await new Promise((r) => setTimeout(r, XMR_MOCK_SWEEP_DELAY_MS));
            }
            return {
                ok: true,
                txId: fakeTxId,
                feeAmount: '(simulated)',
                aliceAmount: aliceAmountPiconero.toString(),
                error: null,
            };
        } finally {
            this._sweepActive = false;
        }
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
    private readonly daemonUrl: string;
    private readonly pollTimers = new Map<string, NodeJS.Timeout>();

    /** Maps swapId → subaddress index for filtering incoming transfers. */
    private readonly subaddrIndices = new Map<string, number>();

    /** Whether a sweep is currently active (wallet-rpc exclusivity). */
    private _sweepActive = false;

    public get sweepActive(): boolean {
        return this._sweepActive;
    }

    public constructor() {
        this.rpcUrl = process.env['XMR_WALLET_RPC_URL'] ?? 'http://localhost:18082/json_rpc';
        this.rpcUser = process.env['XMR_WALLET_RPC_USER'] ?? '';
        this.rpcPass = process.env['XMR_WALLET_RPC_PASS'] ?? '';
        this.daemonUrl = process.env['XMR_DAEMON_URL'] ?? 'http://node.monerodevs.org:18089';
        console.log(`[RealMonero] Configured RPC URL: ${this.rpcUrl}`);
        console.log(`[RealMonero] Configured daemon URL: ${this.daemonUrl}`);

        // Block credentials over plaintext HTTP to remote hosts
        if (this.rpcUser.length > 0 && this.rpcUrl.startsWith('http://')) {
            const urlHost = new URL(this.rpcUrl).hostname;
            if (urlHost !== 'localhost' && urlHost !== '127.0.0.1' && urlHost !== '::1') {
                throw new Error(
                    `SECURITY: RPC credentials configured but URL uses plaintext HTTP to remote host ${urlHost}. ` +
                    `Use HTTPS (https://) or connect via localhost/SSH tunnel to prevent credential exposure.`,
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
        lockTxId?: string,
        splitKeyInfo?: { viewKeyHex: string; restoreHeight?: number },
    ): void {
        const mode = lockTxId ? 'outgoing-tx' : splitKeyInfo ? 'split-key-wallet' : 'incoming-addr';
        console.log(
            `[RealMonero] startMonitoring(${swapId}) — mode: ${mode}, polling every ${XMR_POLL_INTERVAL_MS}ms, expecting ${expectedAmount} piconero` +
            (lockTxId ? `, tracking tx: ${lockTxId.slice(0, 16)}...` : ''),
        );

        // Resolve subaddress index: prefer in-memory (from createLockAddress), fall back to persisted value
        if (recoverySubaddrIndex !== undefined && !this.subaddrIndices.has(swapId)) {
            this.subaddrIndices.set(swapId, recoverySubaddrIndex);
        }
        const subaddrIndex = this.subaddrIndices.get(swapId);

        const pollByAddress = async (): Promise<void> => {
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
                    if (txAmount > expectedAmount) {
                        console.warn(
                            `[RealMonero] Swap ${swapId}: OVERPAYMENT — received ${txAmount} but expected ${expectedAmount}. ` +
                            `Excess ${txAmount - expectedAmount} piconero will be included in sweep.`,
                        );
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

        // Poll the Monero daemon directly for tx confirmations.
        // Works for ANY transaction (no wallet ownership needed).
        const pollByDaemonTx = async (txId: string): Promise<void> => {
            try {
                const confs = await this.daemonGetTxConfirmations(txId);

                if (confs > 0) {
                    onProgress?.(confs);
                    console.log(
                        `[RealMonero] Swap ${swapId}: ${confs} confirmations (daemon, tx: ${txId.slice(0, 16)}...)`,
                    );
                }

                if (confs >= XMR_REQUIRED_CONFIRMATIONS) {
                    onConfirmed(confs, txId);
                    this.stopMonitoring(swapId);
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Unknown error';
                console.error(`[RealMonero] Daemon poll error for swap ${swapId}: ${msg}`);
            }
        };

        // Poll via temporary watch-only wallet for split-key addresses.
        // Creates the wallet once, then swaps to it each poll to refresh & check transfers.
        // Once a txid is found, switches to fast daemon-based monitoring.
        const pollBySplitKeyWallet = (() => {
            const walletName = `monitor-${swapId}`;
            const mainWallet = process.env['XMR_WALLET_NAME'] ?? 'motoxmr-mainnet';
            const mainPassword = process.env['XMR_WALLET_PASSWORD'] ?? 'motoxmr2026';
            let walletCreated = false;
            let pollInFlight = false;

            return async (info: { viewKeyHex: string; restoreHeight?: number }): Promise<void> => {
                // Skip if a sweep or another poll is in progress
                if (this._sweepActive || pollInFlight) return;
                pollInFlight = true;

                try {
                    // Create watch wallet on first poll
                    if (!walletCreated) {
                        let restoreHeight = info.restoreHeight ?? 0;
                        if (restoreHeight === 0) {
                            try {
                                const infoResp = await fetch(`${this.daemonUrl}/json_rpc`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
                                    signal: AbortSignal.timeout(10_000),
                                });
                                const infoData = await infoResp.json() as { result?: { height?: number } };
                                restoreHeight = Math.max(0, (infoData.result?.height ?? 0) - 100);
                            } catch {
                                restoreHeight = 0;
                            }
                        }

                        // Close main wallet, create watch wallet
                        await this.rpcCall('close_wallet', {});
                        try {
                            await this.rpcCall('generate_from_keys', {
                                filename: walletName,
                                address,
                                viewkey: info.viewKeyHex,
                                password: '',
                                restore_height: restoreHeight,
                            });
                        } catch (genErr: unknown) {
                            // Wallet may already exist from a previous run — try opening it
                            const genMsg = genErr instanceof Error ? genErr.message : '';
                            if (genMsg.includes('already exists')) {
                                await this.rpcCall('open_wallet', { filename: walletName, password: '' });
                            } else {
                                throw genErr;
                            }
                        }
                        walletCreated = true;
                        console.log(`[RealMonero] Split-key watch wallet created for swap ${swapId}`);
                    } else {
                        // Subsequent polls: swap from main to watch wallet
                        await this.rpcCall('close_wallet', {});
                        await this.rpcCall('open_wallet', { filename: walletName, password: '' });
                    }

                    // Refresh and check transfers
                    await this.rpcCall('refresh', {});
                    const transfers = await this.rpcCall<IGetTransfersResponse>('get_transfers', {
                        in: true,
                        pool: true,
                        filter_by_height: false,
                    });

                    // Close watch wallet and restore main wallet
                    await this.rpcCall('close_wallet', {});
                    await this.rpcCall('open_wallet', { filename: mainWallet, password: mainPassword });

                    const allTxs: ITransferEntry[] = [
                        ...(transfers.result?.pool ?? []),
                        ...(transfers.result?.in ?? []),
                    ];

                    let bestConfs = 0;
                    let bestTxId = '';

                    for (const tx of allTxs) {
                        const txAmount = BigInt(tx.amount ?? 0);
                        if (txAmount < expectedAmount) continue;
                        const confs = tx.confirmations ?? 0;
                        if (confs > bestConfs) {
                            bestConfs = confs;
                            bestTxId = tx.txid ?? '';
                        }
                    }

                    if (bestConfs > 0) {
                        onProgress?.(bestConfs);
                        console.log(
                            `[RealMonero] Swap ${swapId}: ${bestConfs} confirmations (split-key wallet, tx: ${bestTxId.slice(0, 16)}...)`,
                        );

                        // Once we have a txid, switch to daemon-based monitoring (faster, no wallet swapping)
                        if (bestTxId) {
                            console.log(`[RealMonero] Swap ${swapId}: switching to daemon-based monitoring`);
                            this.stopMonitoring(swapId);
                            this.startMonitoring(swapId, address, expectedAmount, onConfirmed, onProgress, undefined, bestTxId);
                            return;
                        }
                    }

                    if (bestConfs >= XMR_REQUIRED_CONFIRMATIONS) {
                        onConfirmed(bestConfs, bestTxId);
                        this.stopMonitoring(swapId);
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    console.error(`[RealMonero] Split-key poll error for swap ${swapId}: ${msg}`);
                    // Try to restore main wallet on error
                    try {
                        await this.rpcCall('close_wallet', {}).catch(() => {});
                        await this.rpcCall('open_wallet', { filename: mainWallet, password: mainPassword });
                    } catch {
                        console.error(`[RealMonero] CRITICAL: Failed to restore main wallet after split-key poll error`);
                    }
                } finally {
                    pollInFlight = false;
                }
            };
        })();

        // Choose poll strategy:
        // - lockTxId provided: track via daemon RPC (works for any tx)
        // - splitKeyInfo provided: use temporary watch-only wallet (split-key addresses)
        // - subaddress in wallet: track via wallet get_transfers (incoming)
        const poll = lockTxId
            ? (): Promise<void> => pollByDaemonTx(lockTxId)
            : splitKeyInfo
                ? (): Promise<void> => pollBySplitKeyWallet(splitKeyInfo)
                : pollByAddress;

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

    /**
     * Queries the Monero daemon directly for a transaction's confirmation count.
     * Works for ANY transaction on the network — no wallet ownership required.
     */
    private async daemonGetTxConfirmations(txId: string): Promise<number> {
        // Get tx info from daemon
        const txResp = await fetch(`${this.daemonUrl}/get_transactions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txs_hashes: [txId] }),
            signal: AbortSignal.timeout(15_000),
        });
        if (!txResp.ok) throw new Error(`Daemon HTTP ${txResp.status}`);
        const txData = await txResp.json() as {
            txs?: Array<{ in_pool?: boolean; block_height?: number }>;
            status?: string;
        };

        if (txData.status !== 'OK' || !txData.txs || txData.txs.length === 0) {
            return 0; // tx not found yet
        }

        const tx = txData.txs[0];
        if (!tx) return 0;
        if (tx.in_pool) return 0; // in mempool, 0 confirmations

        if (!tx.block_height) return 0;

        // Get current blockchain height
        const infoResp = await fetch(`${this.daemonUrl}/json_rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!infoResp.ok) throw new Error(`Daemon info HTTP ${infoResp.status}`);
        const infoData = await infoResp.json() as {
            result?: { height?: number };
        };

        const currentHeight = infoData.result?.height ?? 0;
        if (currentHeight === 0 || tx.block_height === 0) return 0;

        return Math.max(0, currentHeight - tx.block_height);
    }

    /**
     * Checks if monero-wallet-rpc is reachable by calling get_version,
     * then ensures the coordinator wallet is open.
     */
    public async healthCheck(): Promise<string | null> {
        try {
            const resp = await this.rpcCall<{
                result: { version: number };
            }>('get_version', {});
            const version = resp.result?.version ?? 0;
            console.log(`[RealMonero] healthCheck: connected (version: ${version})`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            return `monero-wallet-rpc unreachable: ${msg}`;
        }

        // Auto-open the coordinator wallet if XMR_WALLET_NAME is set
        const walletName = process.env['XMR_WALLET_NAME'];
        if (walletName) {
            try {
                // Check if a wallet is already open by calling get_balance
                await this.rpcCall('get_balance', { account_index: 0 });
                console.log(`[RealMonero] healthCheck: wallet already open`);
            } catch {
                // No wallet open — open it
                const walletPass = process.env['XMR_WALLET_PASS'] ?? '';
                try {
                    await this.rpcCall('open_wallet', { filename: walletName, password: walletPass });
                    console.log(`[RealMonero] healthCheck: opened wallet '${walletName}'`);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : 'Unknown error';
                    return `Failed to open wallet '${walletName}': ${msg}`;
                }
            }
        }

        return null;
    }

    /**
     * Transfers XMR from the coordinator's wallet to a lock address.
     * Uses monero-wallet-rpc `transfer` method.
     */
    public async transferToLockAddress(
        swapId: string,
        address: string,
        amountPiconero: bigint,
    ): Promise<ITransferResult> {
        try {
            // Check balance first
            const balanceResp = await this.rpcCall<{
                result: { unlocked_balance: number };
            }>('get_balance', { account_index: 0 });
            const unlocked = BigInt(balanceResp.result.unlocked_balance);

            if (unlocked < amountPiconero) {
                const error = `Insufficient XMR balance: have ${unlocked} piconero, need ${amountPiconero}`;
                console.error(`[RealMonero] transferToLockAddress(${swapId}): ${error}`);
                return { ok: false, txId: null, error };
            }

            console.log(
                `[RealMonero] transferToLockAddress(${swapId}): sending ${amountPiconero} piconero to ${address.slice(0, 12)}...`,
            );

            const transferResp = await this.rpcCall<{
                result: { tx_hash: string; fee: number };
            }>('transfer', {
                destinations: [{ amount: Number(amountPiconero), address }],
                account_index: 0,
                priority: 1, // Normal priority
                do_not_relay: false,
                get_tx_key: true,
            });

            const txId = transferResp.result?.tx_hash ?? null;
            const txFee = transferResp.result?.fee ?? 0;
            console.log(
                `[RealMonero] transferToLockAddress(${swapId}): SUCCESS — txId=${txId?.slice(0, 16)}... fee=${txFee} piconero`,
            );

            return { ok: true, txId, error: null };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[RealMonero] transferToLockAddress(${swapId}) FAILED: ${msg}`);
            return { ok: false, txId: null, error: msg };
        }
    }

    /**
     * Sweeps XMR from a completed swap's shared lock address.
     *
     * Flow:
     * 1. Generate a new wallet from the reconstructed spend+view keys
     * 2. Open it and scan for the balance
     * 3. Build a transfer: fee → fee wallet, remainder → Alice
     * 4. Close the temporary wallet
     *
     * Uses monero-wallet-rpc methods:
     * - generate_from_keys: import the reconstructed key pair
     * - open_wallet: switch to the imported wallet
     * - refresh: scan for incoming transactions
     * - get_balance: verify funds are available
     * - transfer_split: send fee + remainder in a single transaction
     * - close_wallet: close the imported wallet
     */
    public async sweepToFeeWallet(
        swapId: string,
        spendKeyHex: string,
        viewKeyHex: string,
        lockAddress: string,
        aliceAmountPiconero: bigint,
        aliceAddress?: string,
    ): Promise<ISweepResult> {
        // Queue handles serialization now — flag only used for split-key poll gating
        this._sweepActive = true;
        try {
            return await this.doSweep(swapId, spendKeyHex, viewKeyHex, lockAddress, aliceAmountPiconero, aliceAddress);
        } finally {
            this._sweepActive = false;
        }
    }

    private async doSweep(
        swapId: string,
        spendKeyHex: string,
        viewKeyHex: string,
        lockAddress: string,
        aliceAmountPiconero: bigint,
        aliceAddress?: string,
    ): Promise<ISweepResult> {
        const walletName = `sweep-${swapId}-${Date.now()}`;
        const feeAddr = xmrFeeAddress;

        if (feeAddr.length === 0 && !aliceAddress) {
            return {
                ok: false,
                txId: null,
                feeAmount: '0',
                aliceAmount: '0',
                error: 'No fee address configured and no Alice address provided — nowhere to send funds',
            };
        }

        try {
            // 1. Import the reconstructed key pair into a temporary wallet.
            // Use a recent restore height to avoid scanning the entire blockchain.
            // Monero mainnet produces ~720 blocks/day. We go back 1500 blocks (~2 days) for safety.
            let restoreHeight = 0;
            try {
                const infoResp = await fetch(`${this.daemonUrl}/json_rpc`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
                    signal: AbortSignal.timeout(10_000),
                });
                const infoData = await infoResp.json() as { result?: { height?: number } };
                const currentHeight = infoData.result?.height ?? 0;
                if (currentHeight > 1500) {
                    restoreHeight = currentHeight - 1500;
                }
            } catch {
                console.warn(`[RealMonero] sweep(${swapId}): could not get daemon height for restore_height, using 0`);
            }

            console.log(`[RealMonero] sweep(${swapId}): importing keys into wallet '${walletName}' (restore_height: ${restoreHeight})`);
            await this.rpcCall('generate_from_keys', {
                filename: walletName,
                address: lockAddress,
                spendkey: spendKeyHex,
                viewkey: viewKeyHex,
                password: '',
                restore_height: restoreHeight,
                autosave_current: false,
            });

            // 2. Open the wallet and refresh to find our balance
            await this.rpcCall('open_wallet', { filename: walletName, password: '' });
            console.log(`[RealMonero] sweep(${swapId}): refreshing wallet (10min timeout)...`);
            await this.rpcCall('refresh', {}, 600_000);

            // 3. Check balance
            const balanceResp = await this.rpcCall<{
                result: { balance: number; unlocked_balance: number };
            }>('get_balance', { account_index: 0 });
            const unlocked = BigInt(balanceResp.result.unlocked_balance);
            console.log(`[RealMonero] sweep(${swapId}): unlocked balance = ${unlocked} piconero`);

            if (unlocked === 0n) {
                await this.closeAndReopen(walletName);
                return {
                    ok: false,
                    txId: null,
                    feeAmount: '0',
                    aliceAmount: '0',
                    error: 'No unlocked balance in shared address — funds may need more confirmations',
                };
            }

            // 4. Sweep strategy:
            //    Two-destination transfer_split: Alice gets exact amount, fee wallet gets the rest.
            //    Network fee is pre-deducted from the fee output so wallet-rpc sees headroom.
            //    Fallback: sweep_all to Alice if fee portion is too small.
            let devFeeAmount = 0n;
            let txId: string | null = null;
            let totalNetworkFee = 0;
            let actualAliceAmount = 0n;

            const dest = aliceAddress ?? feeAddr;
            const expectedDevFee = unlocked - aliceAmountPiconero;

            let usedSweepAll = false;

            // Network fee for a 2-output Monero tx is typically 30-45M piconero.
            // Use a generous estimate so the wallet sees enough headroom.
            const NETWORK_FEE_ESTIMATE = 80_000_000n;

            // Need dev fee > network fee estimate, with enough left to be worth splitting
            const MIN_DEV_FEE_FOR_SPLIT = NETWORK_FEE_ESTIMATE + 10_000_000n; // 90M piconero

            if (feeAddr.length > 0 && aliceAddress && expectedDevFee > MIN_DEV_FEE_FOR_SPLIT) {
                // Pre-deduct estimated network fee from fee output so wallet has natural headroom.
                // Alice gets her exact amount. Fee wallet gets devFee minus network fee.
                // Any leftover (estimate - actual fee) stays as dust in the sweep wallet.
                const feeOutputAmount = expectedDevFee - NETWORK_FEE_ESTIMATE;
                try {
                    const destinations = [
                        { amount: Number(aliceAmountPiconero), address: aliceAddress },
                        { amount: Number(feeOutputAmount), address: feeAddr },
                    ];
                    console.log(
                        `[RealMonero] sweep(${swapId}): transfer_split — alice=${aliceAmountPiconero}, fee=${feeOutputAmount} (to ${feeAddr.slice(0, 16)}...), headroom=${NETWORK_FEE_ESTIMATE}`,
                    );
                    const transferResp = await this.rpcCall<{
                        result: { tx_hash_list?: string[]; fee_list?: number[] };
                    }>('transfer_split', {
                        destinations,
                        account_index: 0,
                        subaddr_indices: [0],
                        ring_size: 16,
                        get_tx_hex: false,
                    });
                    const txIds = transferResp.result?.tx_hash_list ?? [];
                    txId = txIds[0] ?? null;
                    const networkFees = transferResp.result?.fee_list ?? [];
                    totalNetworkFee = networkFees.reduce((sum, f) => sum + f, 0);
                    actualAliceAmount = aliceAmountPiconero;
                    devFeeAmount = feeOutputAmount;
                } catch (splitErr: unknown) {
                    const splitMsg = splitErr instanceof Error ? splitErr.message : String(splitErr);
                    console.warn(
                        `[RealMonero] sweep(${swapId}): transfer_split failed (${splitMsg}) — falling back to sweep_all to Alice`,
                    );
                    usedSweepAll = true;
                }
            } else {
                usedSweepAll = true;
            }

            if (usedSweepAll) {
                // Fallback: sweep_all to Alice (no fee split, but funds are safe)
                console.log(
                    `[RealMonero] sweep(${swapId}): sweep_all to ${dest.slice(0, 16)}...`,
                );
                const sweepResp = await this.rpcCall<{
                    result: { tx_hash_list?: string[]; fee_list?: number[] };
                }>('sweep_all', {
                    address: dest,
                    account_index: 0,
                    subaddr_indices: [0],
                    ring_size: 16,
                    get_tx_hex: false,
                });
                const txIds = sweepResp.result?.tx_hash_list ?? [];
                txId = txIds[0] ?? null;
                const networkFees = sweepResp.result?.fee_list ?? [];
                totalNetworkFee = networkFees.reduce((sum, f) => sum + f, 0);
                actualAliceAmount = unlocked - BigInt(totalNetworkFee);
                devFeeAmount = 0n;
            }

            console.log(
                `[RealMonero] sweep(${swapId}): COMPLETE — txId=${txId?.slice(0, 16) ?? 'unknown'}...` +
                ` networkFee=${totalNetworkFee}, alice=${actualAliceAmount}, devFee=${devFeeAmount}`,
            );

            // 6. Close the temporary wallet and reopen the main one
            await this.closeAndReopen(walletName);

            return {
                ok: true,
                txId,
                feeAmount: devFeeAmount.toString(),
                aliceAmount: actualAliceAmount.toString(),
                error: null,
            };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[RealMonero] sweep(${swapId}) FAILED: ${msg}`);

            // Try to close temporary wallet and restore main wallet
            try {
                await this.closeAndReopen(walletName);
            } catch {
                console.error(`[RealMonero] sweep(${swapId}): failed to restore main wallet after sweep error`);
            }

            return {
                ok: false,
                txId: null,
                feeAmount: '0',
                aliceAmount: '0',
                error: msg,
            };
        }
    }

    /**
     * Closes the current wallet and reopens the main coordinator wallet.
     * The main wallet filename is derived from XMR_WALLET_NAME env var (default: 'coordinator').
     */
    private async closeAndReopen(_tempWalletName: string): Promise<void> {
        try {
            await this.rpcCall('close_wallet', {});
        } catch {
            // May already be closed
        }
        const mainWallet = process.env['XMR_WALLET_NAME'] ?? 'coordinator';
        const mainPassword = process.env['XMR_WALLET_PASS'] ?? '';
        await this.rpcCall('open_wallet', { filename: mainWallet, password: mainPassword });
        console.log(`[RealMonero] Restored main wallet '${mainWallet}'`);
    }

    private async rpcCall<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
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
            signal: AbortSignal.timeout(timeoutMs),
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
        const requireTls = (process.env['REQUIRE_TLS'] ?? 'false').toLowerCase() === 'true';
        if (process.env['NODE_ENV'] === 'production' || requireTls) {
            throw new Error('MONERO_MOCK=true is forbidden in production (NODE_ENV=production or REQUIRE_TLS=true)');
        }
        console.warn('[Monero] *** MOCK MODE *** Using MockMoneroService (MONERO_MOCK=true)');
        return new MockMoneroService();
    }
    console.log('[Monero] Using RealMoneroService');
    return new RealMoneroService();
}
