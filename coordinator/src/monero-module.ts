/**
 * Monero module — preimage/hashLock generation (real SHA-256) + IMoneroService
 * with MockMoneroService (timer-based) and RealMoneroService (monero-wallet-rpc).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type IPreimageResult, SwapStatus, FEE_BPS } from './types.js';
import type { StorageService } from './storage.js';
import type { SwapStateMachine } from './state-machine.js';
import type { SwapWebSocketServer } from './websocket.js';
import { verifyMoneroAddressChecksum, generateEd25519KeyPair, computeSharedMoneroAddress } from './crypto/index.js';

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
/** Maps MONERO_NETWORK env var to valid address prefixes. */
const NETWORK_PREFIXES: Record<string, ReadonlySet<string>> = {
    mainnet: new Set(['4', '8']),
    stagenet: new Set(['5', '7']),
    testnet: new Set(['9', 'A', 'B']),
};

/**
 * Safely converts a BigInt piconero amount to Number for wallet-rpc JSON.
 * Throws if the value exceeds Number.MAX_SAFE_INTEGER (~9,007 XMR).
 * Wallet-rpc accepts amounts as JSON integers, which are safe up to 2^53-1.
 */
function safeAmountToNumber(amount: bigint, context: string): number {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${context}: amount ${amount} exceeds Number.MAX_SAFE_INTEGER — cannot safely convert for wallet-rpc`);
    }
    return Number(amount);
}

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

    // Enforce network match: reject addresses that don't match MONERO_NETWORK.
    // Prevents mainnet XMR from being sent to stagenet addresses (or vice versa).
    const network = process.env['MONERO_NETWORK'] ?? 'stagenet';
    const allowedPrefixes = NETWORK_PREFIXES[network];
    if (allowedPrefixes && firstChar && !allowedPrefixes.has(firstChar)) {
        return `Address prefix '${firstChar}' does not match configured network '${network}' (expected: ${[...allowedPrefixes].join('/')})`;
    }

    // Verify Keccak-256 checksum (prevents typos that pass charset + length checks)
    const checksumErr = verifyMoneroAddressChecksum(address);
    if (checksumErr !== null) {
        return checksumErr;
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
// notifyXmrConfirmed — internal orchestration
// ---------------------------------------------------------------------------

/** Tracks swaps that have already been confirmed to prevent duplicate transitions. */
const xmrConfirmedSwaps = new Set<string>();

/** Clears the confirmed flag for a swap (call on terminal state). */
export function clearXmrConfirmed(swapId: string): void {
    xmrConfirmedSwaps.delete(swapId);
}

export function notifyXmrConfirmed(
    swapId: string,
    confirmations: number,
    storage: StorageService,
    stateMachine: SwapStateMachine,
    wsServer: SwapWebSocketServer,
    currentBlockGetter?: () => bigint,
): void {
    if (xmrConfirmedSwaps.has(swapId)) {
        console.log(`[Monero] notifyXmrConfirmed: swap ${swapId} already confirmed — skipping duplicate`);
        return;
    }
    xmrConfirmedSwaps.add(swapId);

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
        // Critical money-movement state — persist immediately to survive crash
        storage.persistNow();

        // SAFETY: Check HTLC margin before proceeding.
        // Need enough time for sweep (~2 min) + Bob's MOTO claim (~5 min).
        const MIN_BLOCKS_FOR_CLAIM = 50n;
        const currentBlock = currentBlockGetter ? currentBlockGetter() : 0n;
        if (currentBlock === 0n) {
            console.warn(
                `[Monero] notifyXmrConfirmed: swap ${swapId} — current block unknown (watcher not synced). ` +
                `Deferring preimage/sweep until block height is available.`,
            );
            xmrConfirmedSwaps.delete(swapId);
            return;
        }
        const blocksRemaining = BigInt(swap.refund_block) - currentBlock;
        if (blocksRemaining < MIN_BLOCKS_FOR_CLAIM) {
            console.error(
                `[Monero] notifyXmrConfirmed: swap ${swapId} — HTLC margin too tight ` +
                `(${blocksRemaining} blocks remaining, need ≥${MIN_BLOCKS_FOR_CLAIM}). ` +
                `Deferring to protect Bob.`,
            );
            return;
        }

        if (updated.trustless_mode === 1) {
            // Sweep-before-claim: sweep XMR to Alice FIRST, then broadcast preimage.
            // This ensures Alice has her XMR before the preimage goes public on-chain.
            const sweepingSwap = storage.updateSwap(swapId, { sweep_status: 'pending' });
            stateMachine.validate(sweepingSwap, SwapStatus.XMR_SWEEPING);
            const sweeping = storage.updateSwap(
                swapId,
                { status: SwapStatus.XMR_SWEEPING },
                SwapStatus.XMR_LOCKED,
                'XMR confirmed — initiating sweep-before-claim',
            );
            stateMachine.notifyTransition(sweeping, SwapStatus.XMR_LOCKED, SwapStatus.XMR_SWEEPING);
            // Critical: persist XMR_SWEEPING immediately so we don't lose it on crash
            storage.persistNow();

            const feeAddr = xmrFeeAddress.length > 0
                ? `${xmrFeeAddress.slice(0, 12)}...`
                : '(not configured)';
            console.log(
                `[Monero] Swap ${swapId} transitioned to XMR_SWEEPING; sweeping XMR to Alice before preimage broadcast` +
                ` (fee: ${FEE_BPS}bps — Alice gets ${swap.xmr_amount}, platform keeps ${swap.xmr_fee} → ${feeAddr})`,
            );
        } else {
            // Non-trustless: legacy path — broadcast preimage immediately
            wsServer.broadcastPreimageReady(swapId, swap.preimage);

            const feeAddr = xmrFeeAddress.length > 0
                ? `${xmrFeeAddress.slice(0, 12)}...`
                : '(not configured)';
            console.log(
                `[Monero] Swap ${swapId} transitioned to XMR_LOCKED; preimage broadcast via WebSocket` +
                ` (fee: ${FEE_BPS}bps — Alice gets ${swap.xmr_amount}, platform keeps ${swap.xmr_fee} → ${feeAddr})`,
            );
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[Monero] notifyXmrConfirmed failed for swap ${swapId}: ${message}`);
        // Clear from xmrConfirmedSwaps so the swap can be retried on the next monitoring poll.
        // Without this, a failed transition (e.g., optimistic concurrency conflict) permanently
        // prevents the swap from reaching XMR_LOCKED state.
        xmrConfirmedSwaps.delete(swapId);
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
        lockTxId?: string,
        onTxBroadcast?: (txId: string) => void,
    ): Promise<ISweepResult>;

    /**
     * Returns the operator's primary XMR address (used as refund destination
     * for expired swaps where XMR needs recovery).
     */
    getOperatorAddress(): Promise<string | null>;

    /**
     * Ensures the main coordinator wallet is open in wallet-rpc.
     * Call on startup/recovery to fix stale state after crash during sweep.
     */
    ensureMainWalletOpen(): Promise<void>;
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
        // Generate a valid Monero address with correct Keccak-256 checksum
        const moneroNetwork = (process.env['MONERO_NETWORK'] ?? 'stagenet') as 'mainnet' | 'stagenet';
        const kp1 = generateEd25519KeyPair();
        const kp2 = generateEd25519KeyPair();
        const shared = computeSharedMoneroAddress(
            kp1.publicKey, kp2.publicKey,
            kp1.privateKey, kp2.privateKey,
            moneroNetwork,
        );
        console.log(
            `[MockMonero] createLockAddress(${swapId}) → ${shared.address.slice(0, 12)}...${shared.address.slice(-6)}`,
        );
        return Promise.resolve({ address: shared.address, subaddrIndex: this.counter });
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
        _lockTxId?: string,
        onTxBroadcast?: (txId: string) => void,
    ): Promise<ISweepResult> {
        this._sweepActive = true;
        try {
            const fakeTxId = randomBytes(32).toString('hex');
            console.log(
                `[MockMonero] sweepToFeeWallet(${swapId}): alice=${aliceAmountPiconero} piconero → ${aliceAddress ?? 'fee wallet'} (fakeTx: ${fakeTxId.slice(0, 16)}...)`,
            );
            if (onTxBroadcast) onTxBroadcast(fakeTxId);
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

    public async getOperatorAddress(): Promise<string | null> {
        return 'mock_operator_address_for_testing';
    }

    public async ensureMainWalletOpen(): Promise<void> {
        console.log('[MockMonero] ensureMainWalletOpen: mock — no-op');
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

/** Whether the main wallet is in a known unhealthy state (e.g., not open after error). */
let walletUnhealthy = false;
let walletRecoveryTimer: NodeJS.Timeout | null = null;

/** Returns true if the main wallet is in a healthy state. */
export function isWalletHealthy(): boolean {
    return !walletUnhealthy;
}

export class RealMoneroService implements IMoneroService {
    private readonly rpcUrl: string;
    private readonly rpcUser: string;
    private readonly rpcPass: string;
    private readonly daemonUrl: string;
    private readonly walletName: string;
    private readonly walletPass: string;
    private readonly pollTimers = new Map<string, NodeJS.Timeout>();

    /** Maps swapId → subaddress index for filtering incoming transfers. */
    private readonly subaddrIndices = new Map<string, number>();

    /** Whether a sweep is currently active (wallet-rpc exclusivity). */
    private _sweepActive = false;

    /**
     * Global wallet-rpc mutex — serializes ALL operations that switch wallets
     * (split-key polls + sweeps). Prevents interleaving where two polls
     * swap wallets concurrently and corrupt each other's data.
     */
    private _walletRpcLock: Promise<void> = Promise.resolve();

    /** Acquires the wallet-rpc lock. Returns a release function. */
    private async acquireWalletRpcLock(): Promise<() => void> {
        let release: () => void;
        const next = new Promise<void>((resolve) => { release = resolve; });
        const prev = this._walletRpcLock;
        this._walletRpcLock = next;
        await prev;
        return release!;
    }

    public get sweepActive(): boolean {
        return this._sweepActive;
    }

    public constructor() {
        this.rpcUrl = process.env['XMR_WALLET_RPC_URL'] ?? 'http://localhost:18082/json_rpc';
        this.rpcUser = process.env['XMR_WALLET_RPC_USER'] ?? '';
        this.rpcPass = process.env['XMR_WALLET_RPC_PASS'] ?? '';
        this.daemonUrl = process.env['XMR_DAEMON_URL'] ?? 'http://node.monerodevs.org:18089';
        // Cache wallet credentials in private fields, then scrub from process.env
        // to reduce exposure surface (same pattern as ENCRYPTION_KEY in encryption.ts).
        this.walletName = process.env['XMR_WALLET_NAME'] ?? 'coordinator';
        this.walletPass = process.env['XMR_WALLET_PASS'] ?? '';
        delete process.env['XMR_WALLET_PASS'];
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

        // Block plaintext daemon connection to remote hosts on mainnet.
        // An MITM on the daemon connection could feed fake confirmation counts.
        const network = process.env['MONERO_NETWORK'] ?? 'stagenet';
        if (network === 'mainnet' && this.daemonUrl.startsWith('http://')) {
            const daemonHost = new URL(this.daemonUrl).hostname;
            if (daemonHost !== 'localhost' && daemonHost !== '127.0.0.1' && daemonHost !== '::1') {
                throw new Error(
                    `SECURITY: Mainnet daemon URL uses plaintext HTTP to remote host ${daemonHost}. ` +
                    `An MITM could fake confirmation counts, enabling fund theft. ` +
                    `Use HTTPS, Tor (.onion), or an SSH tunnel. ` +
                    `To override (NOT recommended): set XMR_ALLOW_PLAINTEXT_DAEMON=true.`,
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
            const mainWallet = this.walletName;
            const mainPassword = this.walletPass;
            let walletCreated = false;
            let pollInFlight = false;

            return async (info: { viewKeyHex: string; restoreHeight?: number }): Promise<void> => {
                // Skip if another poll for this swap is in progress
                if (pollInFlight) return;
                // Skip polling when wallet is unhealthy — recovery timer will handle restoration
                if (walletUnhealthy) {
                    console.warn(`[RealMonero] Skipping split-key poll for ${swapId} — wallet unhealthy, recovery in progress`);
                    return;
                }
                pollInFlight = true;

                // Acquire global wallet-rpc lock to prevent interleaving with other polls/sweeps
                const releaseLock = await this.acquireWalletRpcLock();
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
                                password: mainPassword,
                                restore_height: restoreHeight,
                            });
                        } catch (genErr: unknown) {
                            // Wallet may already exist from a previous run — try opening it
                            const genMsg = genErr instanceof Error ? genErr.message : '';
                            if (genMsg.includes('already exists')) {
                                await this.rpcCall('open_wallet', { filename: walletName, password: mainPassword });
                            } else {
                                throw genErr;
                            }
                        }
                        walletCreated = true;
                        console.log(`[RealMonero] Split-key watch wallet created for swap ${swapId}`);
                    } else {
                        // Subsequent polls: swap from main to watch wallet
                        await this.rpcCall('close_wallet', {});
                        await this.rpcCall('open_wallet', { filename: walletName, password: mainPassword });
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
                        walletUnhealthy = true;
                        // Start periodic recovery: try to re-open main wallet every 30s
                        // MUST acquire wallet-rpc lock to prevent interleaving with other operations
                        if (!walletRecoveryTimer) {
                            walletRecoveryTimer = setInterval(async () => {
                                const recoveryRelease = await this.acquireWalletRpcLock();
                                try {
                                    await this.rpcCall('close_wallet', {}).catch(() => {});
                                    await this.rpcCall('open_wallet', { filename: mainWallet, password: mainPassword });
                                    console.log(`[RealMonero] Wallet recovery succeeded — main wallet restored`);
                                    walletUnhealthy = false;
                                    if (walletRecoveryTimer) {
                                        clearInterval(walletRecoveryTimer);
                                        walletRecoveryTimer = null;
                                    }
                                } catch {
                                    console.error(`[RealMonero] Wallet recovery attempt failed — retrying in 30s`);
                                } finally {
                                    recoveryRelease();
                                }
                            }, 30_000);
                        }
                    }
                } finally {
                    pollInFlight = false;
                    releaseLock();
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

        // Always ensure the MAIN wallet is open (not a stale sweep wallet from a crash)
        let needsOpen = true;
        try {
            await this.rpcCall('get_balance', { account_index: 0 });
            // A wallet is open — but it might be a stale sweep wallet.
            // Close it and re-open the main wallet to be safe.
            // We can't check which wallet is open (wallet-rpc has no "get_wallet_name" RPC).
            console.log(`[RealMonero] healthCheck: a wallet is already open — closing to ensure main wallet`);
            try {
                await this.rpcCall('close_wallet', {});
            } catch { /* ignore close errors */ }
            needsOpen = true;
        } catch {
            console.log(`[RealMonero] healthCheck: no wallet open`);
        }

        if (needsOpen) {
            if (!this.walletName) {
                return 'No wallet open and XMR_WALLET_NAME not set — cannot auto-open';
            }
            console.log(`[RealMonero] healthCheck: opening main wallet '${this.walletName}'...`);
            try {
                await this.rpcCall('open_wallet', { filename: this.walletName, password: this.walletPass });
                console.log(`[RealMonero] healthCheck: opened main wallet '${this.walletName}'`);
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Unknown error';
                return `Failed to open wallet '${this.walletName}': ${msg}`;
            }
        }

        return null;
    }

    public async getOperatorAddress(): Promise<string | null> {
        try {
            const resp = await this.rpcCall<{
                result: { address: string };
            }>('get_address', { account_index: 0 });
            return resp.result?.address ?? null;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.warn(`[RealMonero] getOperatorAddress failed: ${msg}`);
            return null;
        }
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
                destinations: [{ amount: safeAmountToNumber(amountPiconero, 'transferToLockAddress'), address }],
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
        lockTxId?: string,
        onTxBroadcast?: (txId: string) => void,
    ): Promise<ISweepResult> {
        // Acquire global wallet-rpc lock (prevents interleaving with split-key polls)
        const releaseLock = await this.acquireWalletRpcLock();
        this._sweepActive = true;
        try {
            return await this.doSweep(swapId, spendKeyHex, viewKeyHex, lockAddress, aliceAmountPiconero, aliceAddress, lockTxId, onTxBroadcast);
        } finally {
            this._sweepActive = false;
            releaseLock();
        }
    }

    private async doSweep(
        swapId: string,
        spendKeyHex: string,
        viewKeyHex: string,
        lockAddress: string,
        aliceAmountPiconero: bigint,
        aliceAddress?: string,
        lockTxId?: string,
        onTxBroadcast?: (txId: string) => void,
    ): Promise<ISweepResult> {
        // Pre-sweep health check: verify wallet-rpc is responsive before committing
        try {
            await this.rpcCall<{ result: { version: number } }>('get_version', {});
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            return {
                ok: false, txId: null, feeAmount: '0', aliceAmount: '0',
                error: `wallet-rpc unreachable before sweep — aborting to prevent orphaned state: ${msg}`,
            };
        }

        const walletName = `sweep-${swapId}-${Date.now()}`;
        const sweepWalletPass = this.walletPass;
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

        // Validate sweep destination addresses before sending any funds
        if (aliceAddress) {
            const aliceAddrErr = validateMoneroAddress(aliceAddress);
            if (aliceAddrErr !== null) {
                return {
                    ok: false, txId: null, feeAmount: '0', aliceAmount: '0',
                    error: `Invalid Alice XMR address in sweep path: ${aliceAddrErr}`,
                };
            }
        }
        if (feeAddr.length > 0) {
            const feeAddrErr = validateMoneroAddress(feeAddr);
            if (feeAddrErr !== null) {
                return {
                    ok: false, txId: null, feeAmount: '0', aliceAmount: '0',
                    error: `Invalid fee address in sweep path: ${feeAddrErr}`,
                };
            }
        }

        try {
            // 1. Import the reconstructed key pair into a temporary wallet.
            // Use a recent restore height to avoid scanning the entire blockchain.
            // Monero mainnet produces ~720 blocks/day. We go back 1500 blocks (~2 days) for safety.
            // Compute restore_height: use deposit block height if available, else fall back to currentHeight - 1500.
            // Using the deposit height is more precise (scans only from deposit, not 2 days back)
            // and ensures we don't miss the deposit if the swap was created long ago.
            let restoreHeight = 0;
            try {
                // First, try to get the deposit block height from the stored lock tx
                if (lockTxId && lockTxId.length === 64) {
                    try {
                        const txResp = await fetch(`${this.daemonUrl}/get_transactions`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ txs_hashes: [lockTxId] }),
                            signal: AbortSignal.timeout(15_000),
                        });
                        if (txResp.ok) {
                            const txData = await txResp.json() as {
                                txs?: Array<{ block_height?: number }>;
                                status?: string;
                            };
                            const depositHeight = txData.txs?.[0]?.block_height ?? 0;
                            if (depositHeight > 100) {
                                restoreHeight = depositHeight - 100;
                                console.log(`[RealMonero] sweep(${swapId}): using deposit-based restore_height ${restoreHeight} (deposit at block ${depositHeight})`);
                            }
                        }
                    } catch {
                        console.warn(`[RealMonero] sweep(${swapId}): could not query deposit tx for restore_height`);
                    }
                }
                // Fallback: use currentHeight - 1500 (~2 days back)
                if (restoreHeight === 0) {
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
                password: sweepWalletPass,
                restore_height: restoreHeight,
                autosave_current: false,
            });

            // 2. Open the wallet and refresh to find our balance.
            // NOTE: generate_from_keys already opens the wallet, but explicit open_wallet
            // is kept as a defensive measure — if wallet-rpc internals change, this ensures
            // the wallet is active before refresh. The call is a no-op when already open.
            await this.rpcCall('open_wallet', { filename: walletName, password: sweepWalletPass });
            console.log(`[RealMonero] sweep(${swapId}): refreshing wallet (10min timeout)...`);
            await this.rpcCall('refresh', {}, 600_000);

            // 3. Check balance
            const balanceResp = await this.rpcCall<{
                result: { balance: number; unlocked_balance: number };
            }>('get_balance', { account_index: 0 });
            const unlocked = BigInt(balanceResp.result.unlocked_balance);
            console.log(`[RealMonero] sweep(${swapId}): unlocked balance = ${unlocked} piconero`);

            if (unlocked === 0n) {
                // Zero balance: either funds never arrived or a prior sweep already cleared them.
                // NEVER return ok:true here — a 0-balance wallet is not proof of a prior sweep.
                // The coordinator must see a real txId (persisted in sweep_status/xmr_sweep_tx)
                // before broadcasting the preimage. Returning ok:true on an empty wallet could
                // cause preimage broadcast without actual XMR delivery.
                const totalBalance = BigInt(balanceResp.result.balance);
                const detail = totalBalance === 0n && aliceAmountPiconero > 0n
                    ? 'Shared address completely empty — possible prior unrecorded sweep or deposit never arrived. Manual investigation required.'
                    : 'No unlocked balance in shared address — funds may need more confirmations';
                console.warn(`[RealMonero] sweep(${swapId}): 0 unlocked balance (total: ${totalBalance}, expected: ${aliceAmountPiconero}) — ${detail}`);
                await this.closeAndReopen(walletName);
                return {
                    ok: false,
                    txId: null,
                    feeAmount: '0',
                    aliceAmount: '0',
                    error: detail,
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

            // Guard: unlocked balance must be >= Alice's amount to avoid underflow
            if (unlocked < aliceAmountPiconero) {
                console.warn(
                    `[RealMonero] sweep(${swapId}): unlocked (${unlocked}) < aliceAmount (${aliceAmountPiconero}). ` +
                    `Sending all available balance to Alice via sweep_all.`,
                );
                // Fall through to sweep_all (usedSweepAll will be true)
            }
            const expectedDevFee = unlocked > aliceAmountPiconero ? unlocked - aliceAmountPiconero : 0n;

            let usedSweepAll = false;

            // Network fee for a 2-output Monero tx is typically 30-45M piconero.
            // Use a generous estimate so the wallet sees enough headroom.
            const NETWORK_FEE_ESTIMATE = 80_000_000n;

            // Need dev fee > network fee estimate, with enough left to be worth splitting
            const MIN_DEV_FEE_FOR_SPLIT = NETWORK_FEE_ESTIMATE + 10_000_000n; // 90M piconero

            if (feeAddr.length > 0 && aliceAddress && expectedDevFee > MIN_DEV_FEE_FOR_SPLIT) {
                // Pre-deduct estimated network fee from fee output so wallet has natural headroom.
                // Guard: if expectedDevFee <= NETWORK_FEE_ESTIMATE, feeOutputAmount would be zero or negative.
                // This is already guarded by MIN_DEV_FEE_FOR_SPLIT above, but add explicit check for safety.
                const feeOutputAmount = expectedDevFee > NETWORK_FEE_ESTIMATE ? expectedDevFee - NETWORK_FEE_ESTIMATE : 0n;
                if (feeOutputAmount <= 0n) {
                    console.warn(`[RealMonero] sweep(${swapId}): fee output would be non-positive — falling back to sweep_all`);
                    usedSweepAll = true;
                }
                if (!usedSweepAll) try {
                    const destinations = [
                        { amount: safeAmountToNumber(aliceAmountPiconero, `sweep(${swapId}):alice`), address: aliceAddress },
                        { amount: safeAmountToNumber(feeOutputAmount, `sweep(${swapId}):fee`), address: feeAddr },
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
                    // Persist txId IMMEDIATELY — if coordinator crashes during closeAndReopen,
                    // this ensures the txId is not lost (prevents re-sweep of empty wallet).
                    if (txId && onTxBroadcast) onTxBroadcast(txId);
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
                // Persist txId IMMEDIATELY — if coordinator crashes during closeAndReopen,
                // this ensures the txId is not lost (prevents re-sweep of empty wallet).
                if (txId && onTxBroadcast) onTxBroadcast(txId);
                const networkFees = sweepResp.result?.fee_list ?? [];
                totalNetworkFee = networkFees.reduce((sum, f) => sum + f, 0);
                actualAliceAmount = unlocked - BigInt(totalNetworkFee);
                devFeeAmount = 0n;
            }

            // Reject null txId as success — if wallet-rpc returned empty tx_hash_list,
            // the sweep may not have actually been broadcast.
            if (txId === null) {
                console.error(
                    `[RealMonero] sweep(${swapId}): wallet-rpc returned OK but NO txId — treating as failure`,
                );
                await this.closeAndReopen(walletName);
                return {
                    ok: false,
                    txId: null,
                    feeAmount: '0',
                    aliceAmount: '0',
                    error: 'Sweep succeeded but returned no transaction ID — funds may still be in shared address',
                };
            }

            console.log(
                `[RealMonero] sweep(${swapId}): COMPLETE — txId=${txId.slice(0, 16)}...` +
                ` networkFee=${totalNetworkFee}, alice=${actualAliceAmount}, devFee=${devFeeAmount}`,
            );

            // 6. Close the temporary wallet and reopen the main one.
            // The temp wallet file (walletName) persists on disk in wallet-rpc's --wallet-dir.
            // monero-wallet-rpc has no delete RPC — files must be cleaned manually or via cron.
            // At typical swap volume (~10/day) this accumulates ~1MB/month which is negligible.
            await this.closeAndReopen(walletName);
            console.log(`[RealMonero] sweep(${swapId}): temp wallet '${walletName}' closed (file persists in wallet-dir)`);

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
                console.error(`[RealMonero] sweep(${swapId}): CRITICAL — failed to restore main wallet after sweep error`);
                // Mark wallet as unhealthy and start periodic recovery (same pattern as split-key poll error)
                walletUnhealthy = true;
                if (!walletRecoveryTimer) {
                    walletRecoveryTimer = setInterval(async () => {
                        const recoveryRelease = await this.acquireWalletRpcLock();
                        try {
                            await this.rpcCall('close_wallet', {}).catch(() => {});
                            await this.rpcCall('open_wallet', { filename: this.walletName, password: this.walletPass });
                            console.log(`[RealMonero] Wallet recovery (post-sweep) succeeded — main wallet restored`);
                            walletUnhealthy = false;
                            if (walletRecoveryTimer) {
                                clearInterval(walletRecoveryTimer);
                                walletRecoveryTimer = null;
                            }
                        } catch {
                            console.error(`[RealMonero] Wallet recovery (post-sweep) attempt failed — retrying in 30s`);
                        } finally {
                            recoveryRelease();
                        }
                    }, 30_000);
                }
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
     * Ensures the main coordinator wallet is open in wallet-rpc.
     * Call on startup/recovery to fix stale state after crash during sweep.
     */
    public async ensureMainWalletOpen(): Promise<void> {
        try {
            // Try a simple balance check to see if any wallet is open
            await this.rpcCall('get_balance', { account_index: 0 });
            console.log('[RealMonero] ensureMainWalletOpen: wallet already open');
        } catch {
            // No wallet open or wrong wallet — close and reopen main
            console.log(`[RealMonero] ensureMainWalletOpen: reopening main wallet '${this.walletName}'`);
            try { await this.rpcCall('close_wallet', {}); } catch { /* may already be closed */ }
            await this.rpcCall('open_wallet', { filename: this.walletName, password: this.walletPass });
            console.log(`[RealMonero] ensureMainWalletOpen: main wallet '${this.walletName}' opened`);
        }
    }

    /**
     * Closes the current wallet and reopens the main coordinator wallet.
     */
    private async closeAndReopen(_tempWalletName: string): Promise<void> {
        try {
            await this.rpcCall('close_wallet', {});
        } catch {
            // May already be closed
        }
        await this.rpcCall('open_wallet', { filename: this.walletName, password: this.walletPass });
        console.log(`[RealMonero] Restored main wallet '${this.walletName}'`);
    }

    // Circuit breaker: consecutive failures → short-circuit for CIRCUIT_BREAKER_COOLDOWN_MS
    private consecutiveRpcFailures = 0;
    private circuitBreakerOpenUntil = 0;
    private static readonly CIRCUIT_BREAKER_THRESHOLD = 5;
    private static readonly CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

    private async rpcCall<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
        // Circuit breaker check — skip non-essential calls while cooling down.
        // Always allow critical wallet operations (open_wallet, close_wallet, generate_from_keys)
        // through the breaker to enable wallet recovery.
        const criticalMethods = new Set(['open_wallet', 'close_wallet', 'generate_from_keys', 'get_version']);
        if (this.circuitBreakerOpenUntil > Date.now() && !criticalMethods.has(method)) {
            throw new Error(`Monero RPC circuit breaker OPEN — ${this.consecutiveRpcFailures} consecutive failures. Next attempt in ${Math.ceil((this.circuitBreakerOpenUntil - Date.now()) / 1000)}s`);
        }

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.rpcUser.length > 0) {
            const credentials = `${this.rpcUser}:${this.rpcPass}`;
            const encoded = btoa(credentials);
            headers['Authorization'] = `Basic ${encoded}`;
        }

        try {
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

            // Success — reset circuit breaker
            this.consecutiveRpcFailures = 0;
            this.circuitBreakerOpenUntil = 0;

            return json as T;
        } catch (err) {
            this.consecutiveRpcFailures++;
            if (this.consecutiveRpcFailures >= RealMoneroService.CIRCUIT_BREAKER_THRESHOLD) {
                this.circuitBreakerOpenUntil = Date.now() + RealMoneroService.CIRCUIT_BREAKER_COOLDOWN_MS;
                console.error(`[RealMonero] Circuit breaker OPENED after ${this.consecutiveRpcFailures} consecutive failures — cooldown ${RealMoneroService.CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`);
            }
            throw err;
        }
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
