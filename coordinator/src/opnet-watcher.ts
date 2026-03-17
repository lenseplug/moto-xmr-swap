/**
 * OPNet watcher — polls the SwapVault contract for on-chain state changes.
 */

import { getContract, JSONRpcProvider, ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI, type BitcoinInterfaceAbi, type IOP_NETContract, type CallResult } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import type { Address } from '@btc-vision/transaction';
import { type IOnChainSwap, type ISwapRecord, type IUpdateSwapParams, SwapStatus, calculateXmrFee, calculateXmrTotal } from './types.js';
import { StorageService } from './storage.js';
import { SwapStateMachine } from './state-machine.js';
import { ed25519PublicFromPrivate } from './crypto/index.js';
import { withSwapLock } from './routes/swaps.js';
import { createLogger } from './logger.js';

const log = createLogger('watcher');

/** Typed SwapVault contract interface for coordinator-side reads. */
interface ISwapVaultContract extends IOP_NETContract {
    getSwapCount(): Promise<CallResult<{ count: bigint }>>;
    getSwap(swapId: bigint): Promise<CallResult<{
        hashLock: bigint;
        refundBlock: bigint;
        amount: bigint;
        xmrAmount: bigint;
        depositor: Address;
        counterparty: Address;
        status: bigint;
        xmrAddressHi: bigint;
        xmrAddressLo: bigint;
    }>>;
}

const OPNET_RPC_URL = 'https://testnet.opnet.org';
const POLL_INTERVAL_MS = 15_000;
const MAX_RETRY_DELAY_MS = 30_000;
const CONTRACT_ADDRESS = process.env['SWAP_CONTRACT_ADDRESS'] ?? '';

/** Number of blocks to wait after first observing an on-chain status change before processing it.
 *  Provides reorg protection (~90s at 15s/block). */
const CONFIRMATION_DEPTH = 6;

/** SwapVault ABI using proper ABIDataTypes enum values. */
const SWAP_VAULT_ABI: BitcoinInterfaceAbi = [
    {
        name: 'getSwapCount',
        inputs: [],
        outputs: [{ name: 'count', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getSwap',
        inputs: [{ name: 'swapId', type: ABIDataTypes.UINT256 }],
        outputs: [
            { name: 'hashLock', type: ABIDataTypes.UINT256 },
            { name: 'refundBlock', type: ABIDataTypes.UINT256 },
            { name: 'amount', type: ABIDataTypes.UINT256 },
            { name: 'xmrAmount', type: ABIDataTypes.UINT256 },
            { name: 'depositor', type: ABIDataTypes.ADDRESS },
            { name: 'counterparty', type: ABIDataTypes.ADDRESS },
            { name: 'status', type: ABIDataTypes.UINT256 },
            { name: 'xmrAddressHi', type: ABIDataTypes.UINT256 },
            { name: 'xmrAddressLo', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getActiveSwaps',
        inputs: [],
        outputs: [{ name: 'swapIds', type: ABIDataTypes.ARRAY_OF_UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    ...OP_NET_ABI,
] as unknown as BitcoinInterfaceAbi;

/**
 * Maps on-chain numeric status values to coordinator SwapStatus.
 * On-chain status 2 = "claimed by counterparty" maps to MOTO_CLAIMING
 * (not COMPLETED). COMPLETED is a coordinator-only terminal state that
 * requires additional processing (e.g., Alice sweeping XMR).
 */
function mapOnChainStatus(raw: bigint): SwapStatus | null {
    switch (raw) {
        case 0n:
            return SwapStatus.OPEN;
        case 1n:
            return SwapStatus.TAKEN;
        case 2n:
            return SwapStatus.MOTO_CLAIMING;
        case 3n:
            return SwapStatus.REFUNDED;
        default:
            console.warn(`[OPNet Watcher] Unknown on-chain status value: ${raw} — skipping`);
            return null;
    }
}

/** Exponential backoff helper. */
async function withRetry<T>(
    fn: () => Promise<T>,
    maxAttempts = 5,
    baseDelayMs = 1000,
): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err: unknown) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const delay = Math.min(baseDelayMs * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
            console.warn(`RPC attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`);
            await sleep(delay);
        }
    }
    throw lastError;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** OPNet polling watcher for the SwapVault contract. */
export class OpnetWatcher {
    private readonly provider: JSONRpcProvider;
    private readonly storage: StorageService;
    private readonly stateMachine: SwapStateMachine;
    private currentBlockNumber: bigint = 0n;
    private pollTimer: NodeJS.Timeout | null = null;
    private running = false;
    private lastKnownSwapCount: bigint = 0n;

    /** Cached contract instance to avoid recreation on every poll. */
    private cachedContract: ISwapVaultContract | null = null;

    /** Tracks the highest block number observed per swap to detect reorgs. */
    private readonly lastSeenBlock = new Map<string, bigint>();

    /** Tracks (swapId:status) → block number where an on-chain status change was first seen.
     *  Events are only processed after CONFIRMATION_DEPTH blocks have passed. */
    private readonly pendingConfirmations = new Map<string, { status: SwapStatus; firstSeenBlock: bigint }>();

    public constructor(storage: StorageService, stateMachine: SwapStateMachine) {
        this.storage = storage;
        this.stateMachine = stateMachine;
        this.provider = new JSONRpcProvider({
            url: OPNET_RPC_URL,
            network: networks.opnetTestnet,
            timeout: 20_000,
        });

        // Refuse to start without a contract address — silent empty string would skip all polling
        // and silently miss on-chain events, risking fund loss.
        const isMockMode = (process.env['MONERO_MOCK'] ?? 'false').toLowerCase() === 'true';
        if (!CONTRACT_ADDRESS && !isMockMode) {
            console.error(
                '[OPNet Watcher] FATAL: SWAP_CONTRACT_ADDRESS is not set. Cannot monitor on-chain state.\n' +
                '[OPNet Watcher] Set SWAP_CONTRACT_ADDRESS in your .env file.',
            );
            process.exit(1);
        }

        // Allow tests to seed a non-zero block height so startXmrLocking doesn't defer.
        const mockBlock = process.env['MOCK_BLOCK_HEIGHT'];
        if (mockBlock) {
            this.currentBlockNumber = BigInt(mockBlock);
        }
    }

    /** Returns the most recently observed block number. */
    public getCurrentBlock(): bigint {
        return this.currentBlockNumber;
    }

    /** Starts the polling loop. */
    public start(): void {
        if (this.running) return;
        this.running = true;
        console.log('[OPNet Watcher] Starting polling loop...');
        void this.poll();
    }

    /** Stops the polling loop gracefully. */
    public stop(): void {
        this.running = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        console.log('[OPNet Watcher] Stopped.');
    }

    /** Fetches the current block number from OPNet. */
    public async fetchBlockNumber(): Promise<bigint> {
        const block = await withRetry(() => this.provider.getBlockNumber());
        this.currentBlockNumber = block;
        return block;
    }

    private async poll(): Promise<void> {
        if (!this.running) return;

        try {
            await this.fetchBlockNumber();
            await this.checkForNewSwaps();
            await this.refreshActiveSwaps();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[OPNet Watcher] Poll error: ${msg}`);
        }

        this.pollTimer = setTimeout(() => {
            void this.poll();
        }, POLL_INTERVAL_MS);
    }

    /** Returns a cached, typed SwapVault contract instance. */
    private getSwapContract(): ISwapVaultContract {
        if (!this.cachedContract) {
            this.cachedContract = getContract<ISwapVaultContract>(
                CONTRACT_ADDRESS,
                SWAP_VAULT_ABI,
                this.provider,
                networks.opnetTestnet,
            );
        }
        return this.cachedContract;
    }

    private async checkForNewSwaps(): Promise<void> {
        if (!CONTRACT_ADDRESS) return;

        try {
            const contract = this.getSwapContract();
            const countResult = await withRetry(() => contract.getSwapCount());

            if ('error' in countResult) {
                const errMsg = (countResult as { error: string }).error;
                console.error(`[OPNet Watcher] getSwapCount error: ${errMsg}`);
                return;
            }

            const count = countResult.properties.count;
            console.log(`[OPNet Watcher] getSwapCount returned: ${count} (type: ${typeof count}, lastKnown: ${this.lastKnownSwapCount})`);
            if (count === undefined) return;

            if (count > this.lastKnownSwapCount) {
                console.log(`[OPNet Watcher] New swaps detected: ${this.lastKnownSwapCount} → ${count}`);
                await this.syncSwapRange(this.lastKnownSwapCount, count, contract);
                this.lastKnownSwapCount = count;
            }
        } catch (err: unknown) {
            if (err instanceof Error) {
                console.error(`[OPNet Watcher] checkForNewSwaps failed: ${err.message}`);
            }
        }
    }

    private async syncSwapRange(
        from: bigint,
        to: bigint,
        contract: ISwapVaultContract,
    ): Promise<void> {
        for (let i = from; i < to; i++) {
            try {
                await this.fetchAndUpsertSwap(i, contract);
            } catch (err: unknown) {
                if (err instanceof Error) {
                    console.error(`[OPNet Watcher] Failed to sync swap ${i}: ${err.message}`);
                }
            }
        }
    }

    private async refreshActiveSwaps(): Promise<void> {
        if (!CONTRACT_ADDRESS) return;

        // Include EXPIRED swaps — they can still transition to REFUNDED via on-chain refund.
        const activeSwaps = [
            ...this.storage.getActiveSwaps(),
            ...this.storage.getSwapsByStatus(SwapStatus.EXPIRED),
        ];
        if (activeSwaps.length === 0) return;

        try {
            const contract = this.getSwapContract();

            for (const swap of activeSwaps) {
                try {
                    const swapIdNum = BigInt(swap.swap_id);
                    await this.fetchAndUpsertSwap(swapIdNum, contract);
                } catch (err: unknown) {
                    if (err instanceof Error) {
                        console.warn(
                            `[OPNet Watcher] Failed to refresh swap ${swap.swap_id}: ${err.message}`,
                        );
                    }
                }
            }
        } catch (err: unknown) {
            if (err instanceof Error) {
                console.error(`[OPNet Watcher] refreshActiveSwaps failed: ${err.message}`);
            }
        }
    }

    private async fetchAndUpsertSwap(
        swapId: bigint,
        contract: ISwapVaultContract,
    ): Promise<void> {
        const result = await withRetry(() => contract.getSwap(swapId));

        if ('error' in result) {
            const errMsg = (result as { error: string }).error;
            console.warn(`[OPNet Watcher] getSwap(${swapId}) error: ${errMsg}`);
            return;
        }

        const props = result.properties;

        const onChain: IOnChainSwap = {
            swapId,
            hashLock: props.hashLock ?? 0n,
            refundBlock: props.refundBlock ?? 0n,
            amount: props.amount ?? 0n,
            xmrAmount: props.xmrAmount ?? 0n,
            depositor: props.depositor?.toString() ?? '',
            counterparty: props.counterparty?.toString() ?? '',
            status: props.status ?? 0n,
            xmrAddressHi: props.xmrAddressHi ?? 0n,
            xmrAddressLo: props.xmrAddressLo ?? 0n,
        };

        await this.upsertFromOnChain(onChain);
    }

    /**
     * Coordinator-only intermediate states that should NOT be overwritten
     * by on-chain status polling. The on-chain contract only knows
     * OPEN/TAKEN/COMPLETED/REFUNDED, but the coordinator has richer states.
     */
    private static readonly COORDINATOR_ONLY_STATES: ReadonlySet<SwapStatus> = new Set([
        SwapStatus.XMR_LOCKING,
        SwapStatus.XMR_LOCKED,
        SwapStatus.XMR_SWEEPING,
        SwapStatus.MOTO_CLAIMING,
    ]);

    private async upsertFromOnChain(onChain: IOnChainSwap): Promise<void> {
        const swapIdStr = onChain.swapId.toString();
        const onChainMappedStatus = mapOnChainStatus(onChain.status);

        // Unknown on-chain status — skip processing entirely
        if (onChainMappedStatus === null) return;

        // Reorg detection: warn if block number decreases for this swap.
        // A reorg could cause a confirmed state to be undone.
        const prevBlock = this.lastSeenBlock.get(swapIdStr) ?? 0n;
        if (this.currentBlockNumber > 0n && this.currentBlockNumber < prevBlock) {
            log.warn(`POSSIBLE REORG: block ${this.currentBlockNumber} < previous ${prevBlock}`, swapIdStr);
            // Clear pending confirmations for this swap — reorg invalidates observation depth
            for (const key of this.pendingConfirmations.keys()) {
                if (key.startsWith(`${swapIdStr}:`)) {
                    this.pendingConfirmations.delete(key);
                }
            }
        }
        if (this.currentBlockNumber > prevBlock) {
            this.lastSeenBlock.set(swapIdStr, this.currentBlockNumber);
        }

        // Acquire per-swap lock to prevent race conditions with route handlers
        await withSwapLock(swapIdStr, async () => {
            this.doUpsertFromOnChain(onChain, swapIdStr, onChainMappedStatus);
        });
    }

    private doUpsertFromOnChain(onChain: IOnChainSwap, swapIdStr: string, onChainMappedStatus: SwapStatus): void {
        const existing = this.storage.getSwap(swapIdStr);

        if (!existing) {
            const xmrAmountStr = onChain.xmrAmount.toString();
            if (onChain.xmrAmount <= 0n) {
                console.warn(`[OPNet Watcher] Skipping swap ${swapIdStr} — xmrAmount is zero or negative`);
                return;
            }
            const xmrFee = calculateXmrFee(xmrAmountStr);
            const xmrTotal = calculateXmrTotal(xmrAmountStr);

            const hashLockHex = onChain.hashLock.toString(16).padStart(64, '0');
            if (!/^[a-f0-9]{64}$/.test(hashLockHex)) {
                console.error(`[OPNet Watcher] Swap ${swapIdStr}: invalid hashLock format after conversion: '${hashLockHex.slice(0, 20)}...'`);
                return;
            }

            // Check for pre-registered secret backup
            const backup = this.storage.getSecretBackup(hashLockHex);

            this.storage.createSwap({
                swap_id: swapIdStr,
                hash_lock: hashLockHex,
                refund_block: Number(onChain.refundBlock),
                moto_amount: onChain.amount.toString(),
                xmr_amount: xmrAmountStr,
                xmr_fee: xmrFee,
                xmr_total: xmrTotal,
                xmr_address: null,
                depositor: onChain.depositor,
                opnet_create_tx: null,
                alice_xmr_payout: backup?.aliceXmrPayout ?? null,
            });
            console.log(`[OPNet Watcher] Created swap record for on-chain swap ${swapIdStr} (fee: ${xmrFee}, total: ${xmrTotal})`);

            // Auto-apply backed-up secret so coordinator has it immediately
            if (backup) {
                const secretBytes = new Uint8Array(32);
                for (let b = 0; b < 32; b++) {
                    secretBytes[b] = parseInt(backup.preimage.slice(b * 2, b * 2 + 2), 16);
                }
                const alicePub = ed25519PublicFromPrivate(secretBytes);
                const alicePubHex = Array.from(alicePub).map((x) => x.toString(16).padStart(2, '0')).join('');

                const updateParams: Record<string, string | number | null> = {
                    preimage: backup.preimage,
                };
                if (backup.aliceViewKey) {
                    updateParams['trustless_mode'] = 1;
                    updateParams['alice_ed25519_pub'] = alicePubHex;
                    updateParams['alice_view_key'] = backup.aliceViewKey;
                }
                this.storage.updateSwap(swapIdStr, updateParams as import('./types.js').IUpdateSwapParams);
                this.storage.markSecretBackupApplied(hashLockHex);
                console.log(`[OPNet Watcher] Auto-applied backed-up secret for swap ${swapIdStr}`);
            }
            return;
        }

        // Don't regress coordinator-managed intermediate states.
        // The on-chain contract maps TAKEN for all of XMR_LOCKING/XMR_LOCKED/MOTO_CLAIMING.
        // Allow MOTO_CLAIMING/REFUNDED to pass through (terminal transitions from on-chain).
        if (
            OpnetWatcher.COORDINATOR_ONLY_STATES.has(existing.status) &&
            onChainMappedStatus !== SwapStatus.MOTO_CLAIMING &&
            onChainMappedStatus !== SwapStatus.REFUNDED
        ) {
            // Still update counterparty if it changed (take confirmed on-chain while
            // coordinator was already in XMR_LOCKING/XMR_LOCKED).
            if (
                onChain.counterparty.length > 0 &&
                onChain.counterparty !== existing.counterparty
            ) {
                this.storage.updateSwap(swapIdStr, { counterparty: onChain.counterparty });
                console.log(`[OPNet Watcher] Swap ${swapIdStr}: counterparty updated (on-chain confirmed)`);
            }
            return;
        }

        if (existing.status === onChainMappedStatus) return;
        if (this.stateMachine.isTerminal(existing.status)) return;
        if (!this.stateMachine.canTransition(existing.status, onChainMappedStatus)) return;

        // CONFIRMATION_DEPTH gate: delay processing until the status has been observed
        // for at least CONFIRMATION_DEPTH blocks to protect against reorgs.
        const pendingKey = `${swapIdStr}:${onChainMappedStatus}`;
        const pending = this.pendingConfirmations.get(pendingKey);
        if (!pending) {
            this.pendingConfirmations.set(pendingKey, { status: onChainMappedStatus, firstSeenBlock: this.currentBlockNumber });
            log.info(`Pending confirmation (depth 0/${CONFIRMATION_DEPTH})`, swapIdStr, { onChainStatus: onChainMappedStatus, firstSeenBlock: Number(this.currentBlockNumber) });
            return;
        }
        const depth = this.currentBlockNumber - pending.firstSeenBlock;
        if (depth < BigInt(CONFIRMATION_DEPTH)) {
            return; // Not yet confirmed deep enough
        }
        // Confirmed — remove from pending and proceed
        this.pendingConfirmations.delete(pendingKey);

        const prevStatus = existing.status;
        const hasNewCounterparty =
            onChain.counterparty.length > 0 &&
            onChain.counterparty !== existing.counterparty;

        // Set refund TX marker for terminal transitions so state machine guards are satisfied
        if (onChainMappedStatus === SwapStatus.REFUNDED && !existing.opnet_refund_tx) {
            this.storage.updateSwap(swapIdStr, { opnet_refund_tx: 'on-chain-confirmed' });
        }

        // On-chain CLAIMED (status 2) → MOTO_CLAIMING, then immediately → COMPLETED.
        // Set opnet_claim_tx to satisfy the COMPLETED guard.
        if (onChainMappedStatus === SwapStatus.MOTO_CLAIMING) {
            if (!existing.opnet_claim_tx) {
                this.storage.updateSwap(swapIdStr, { opnet_claim_tx: 'on-chain-confirmed' });
            }
        }

        // Re-read swap after pre-setting fields, then validate guards
        const preUpdated = this.storage.getSwap(swapIdStr);
        if (!preUpdated) return;

        // Apply counterparty if needed before guard validation
        const validationSwap = hasNewCounterparty
            ? { ...preUpdated, counterparty: onChain.counterparty } as typeof preUpdated
            : preUpdated;

        try {
            this.stateMachine.validate(validationSwap, onChainMappedStatus);
        } catch (guardErr: unknown) {
            const msg = guardErr instanceof Error ? guardErr.message : String(guardErr);
            console.warn(`[OPNet Watcher] Guard rejected ${prevStatus} → ${onChainMappedStatus} for swap ${swapIdStr}: ${msg}`);
            return;
        }

        const updates: IUpdateSwapParams = hasNewCounterparty
            ? { status: onChainMappedStatus, counterparty: onChain.counterparty }
            : { status: onChainMappedStatus };

        const updated = this.storage.updateSwap(swapIdStr, updates, prevStatus);
        this.stateMachine.notifyTransition(updated, prevStatus, onChainMappedStatus);
        log.info(`on-chain ${prevStatus} → ${onChainMappedStatus}`, swapIdStr, { from: prevStatus, to: onChainMappedStatus });

        // After transitioning to MOTO_CLAIMING, immediately transition to COMPLETED.
        // On-chain CLAIMED means the claim TX is confirmed — the swap is done.
        if (onChainMappedStatus === SwapStatus.MOTO_CLAIMING) {
            const current = this.storage.getSwap(swapIdStr);
            if (current) {
                try {
                    this.stateMachine.validate(current, SwapStatus.COMPLETED);
                    const completed = this.storage.updateSwap(
                        swapIdStr,
                        { status: SwapStatus.COMPLETED },
                        SwapStatus.MOTO_CLAIMING,
                        'On-chain claim confirmed',
                    );
                    this.stateMachine.notifyTransition(completed, SwapStatus.MOTO_CLAIMING, SwapStatus.COMPLETED);
                    console.log(`[OPNet Watcher] Swap ${swapIdStr}: MOTO_CLAIMING → COMPLETED (on-chain confirmed)`);
                } catch (guardErr: unknown) {
                    const msg = guardErr instanceof Error ? guardErr.message : String(guardErr);
                    console.warn(`[OPNet Watcher] Guard rejected MOTO_CLAIMING → COMPLETED for swap ${swapIdStr}: ${msg}`);
                }
            }
        }
    }

    /**
     * Checks all active swaps against the current block to mark expired ones.
     * @param currentBlock - The current OPNet block number.
     */
    /** Prunes lastSeenBlock entries for swaps that have reached terminal state. */
    public pruneLastSeenBlock(): void {
        let pruned = 0;
        for (const swapId of this.lastSeenBlock.keys()) {
            const swap = this.storage.getSwap(swapId);
            if (!swap || this.stateMachine.isTerminal(swap.status) || swap.status === SwapStatus.EXPIRED) {
                this.lastSeenBlock.delete(swapId);
                // Also clean up any pending confirmations for this swap
                for (const key of this.pendingConfirmations.keys()) {
                    if (key.startsWith(`${swapId}:`)) {
                        this.pendingConfirmations.delete(key);
                    }
                }
                pruned++;
            }
        }
        if (pruned > 0) {
            console.log(`[OPNet Watcher] Pruned ${pruned} lastSeenBlock entries (${this.lastSeenBlock.size} remaining)`);
        }
    }

    public checkExpirations(currentBlock: bigint): ISwapRecord[] {
        // Periodically prune lastSeenBlock to prevent unbounded memory growth
        this.pruneLastSeenBlock();

        const active = this.storage.getActiveSwaps();
        const expired: ISwapRecord[] = [];

        for (const swap of active) {
            try {
                if (this.stateMachine.isTerminal(swap.status)) continue;
                if (swap.status === SwapStatus.EXPIRED) continue;

                // Never auto-expire XMR_LOCKED or XMR_SWEEPING — doing so creates a
                // double-spend race where the preimage is already revealed/broadcast
                // but the coordinator would also sweep XMR back to the operator.
                if (swap.status === SwapStatus.XMR_LOCKED || swap.status === SwapStatus.XMR_SWEEPING) continue;

                if (BigInt(swap.refund_block) <= currentBlock) {
                    if (!this.stateMachine.canTransition(swap.status, SwapStatus.EXPIRED)) continue;

                    const prev = swap.status;
                    const updated = this.storage.updateSwap(
                        swap.swap_id,
                        { status: SwapStatus.EXPIRED },
                        prev,
                        `Block ${currentBlock} exceeded refund block ${swap.refund_block}`,
                    );
                    this.stateMachine.notifyTransition(updated, prev, SwapStatus.EXPIRED);
                    expired.push(updated);
                    log.info(`Expired at block ${currentBlock}`, swap.swap_id, { currentBlock: Number(currentBlock), refundBlock: swap.refund_block });
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Unknown error';
                console.error(`[OPNet Watcher] checkExpirations: error processing swap ${swap.swap_id}: ${msg}`);
            }
        }

        return expired;
    }
}
