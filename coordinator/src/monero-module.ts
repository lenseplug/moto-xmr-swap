/**
 * Monero module — preimage/hashLock generation (real SHA-256) with stubbed XMR wallet ops.
 *
 * The Monero RPC/wallet integration is architecturally in place but stubbed for MVP.
 * Real XMR operations require a running monerod + monero-wallet-rpc node.
 */

import { createHash, randomBytes } from 'node:crypto';
import { type IMonitorLockResult, type IPreimageResult, SwapStatus } from './types.js';
import type { StorageService } from './storage.js';
import type { SwapStateMachine } from './state-machine.js';
import type { SwapWebSocketServer } from './websocket.js';

const XMR_REQUIRED_CONFIRMATIONS = 10;

/**
 * Generates a cryptographically random preimage and its SHA-256 hash lock.
 * This is real and not stubbed.
 * @returns Hex-encoded preimage (32 bytes) and hashLock (32 bytes).
 */
export function generatePreimage(): IPreimageResult {
    const preimageBytes = randomBytes(32);
    const preimage = preimageBytes.toString('hex');
    const hashLockBytes = createHash('sha256').update(preimageBytes).digest();
    const hashLock = hashLockBytes.toString('hex');
    return { preimage, hashLock };
}

/**
 * Derives the SHA-256 hash of a known preimage — for verifying a claim.
 * @param preimage - Hex-encoded 32-byte preimage.
 * @returns Hex-encoded SHA-256 hash.
 */
export function hashPreimage(preimage: string): string {
    const preimageBytes = hexToUint8Array(preimage);
    const hash = createHash('sha256').update(preimageBytes).digest();
    return hash.toString('hex');
}

/**
 * Verifies that a preimage matches the expected hash lock.
 * @param preimage - Hex-encoded preimage.
 * @param expectedHashLock - Hex-encoded expected hash lock.
 */
export function verifyPreimage(preimage: string, expectedHashLock: string): boolean {
    const computed = hashPreimage(preimage);
    return computed === expectedHashLock.toLowerCase();
}

/**
 * Internal-only: Called by the coordinator's XMR monitoring loop once 10 confirmations
 * are detected on-chain. Transitions the swap from XMR_LOCKING to XMR_LOCKED, then
 * broadcasts the preimage via WebSocket so Bob's frontend can call claim().
 *
 * This must NEVER be triggered by an external HTTP request.
 *
 * @param swapId - The coordinator swap ID.
 * @param confirmations - Actual confirmation count (must be >= 10).
 * @param storage - The storage service.
 * @param stateMachine - The swap state machine.
 * @param wsServer - The WebSocket server for broadcasting the preimage.
 */
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
        // Update confirmation count and transition to XMR_LOCKED.
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

        // Broadcast the preimage ONLY via WebSocket — never via HTTP.
        // Bob's frontend receives this and calls claim() on the OPNet contract.
        wsServer.broadcastPreimageReady(swapId, swap.preimage);

        console.log(
            `[Monero] Swap ${swapId} transitioned to XMR_LOCKED; preimage broadcast via WebSocket`,
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[Monero] notifyXmrConfirmed failed for swap ${swapId}: ${message}`);
    }
}

/**
 * Stub: Creates a Monero subaddress for locking funds.
 *
 * In production this would call the monero-wallet-rpc `create_address` endpoint
 * with a deterministic path derived from the secret, ensuring the coordinator
 * can sweep the funds once the preimage is revealed.
 *
 * @param _secret - The swap secret (preimage) used to derive the lock address.
 * @returns A placeholder stagenet XMR subaddress.
 */
export function createLockAddress(_secret: string): string {
    console.log('[Monero] STUB: createLockAddress called — returning placeholder address');
    return '76Rp37...STUB_XMR_STAGENET_ADDRESS';
}

/**
 * Stub: Monitors a Monero address for incoming funds and returns confirmation count.
 *
 * In production this would call `get_transfers` on monero-wallet-rpc and count
 * confirmations for transactions to `address` matching `expectedAmount`.
 *
 * @param address - The XMR lock address to monitor.
 * @param _expectedAmount - The expected XMR amount in atomic units (piconero).
 * @returns Confirmation count and whether the required threshold is met.
 */
export function monitorLock(
    address: string,
    _expectedAmount: bigint,
): Promise<IMonitorLockResult> {
    console.log(
        `[Monero] STUB: monitorLock called for ${address} — returning 0 confirmations`,
    );
    return Promise.resolve({
        confirmations: 0,
        confirmed: false,
    });
}

/**
 * Stub: Checks if a Monero lock has the required number of confirmations.
 *
 * @param address - The XMR lock address to check.
 * @param requiredConfs - Minimum confirmations required.
 * @returns Whether the lock is sufficiently confirmed.
 */
export async function isLockConfirmed(
    address: string,
    requiredConfs = XMR_REQUIRED_CONFIRMATIONS,
): Promise<boolean> {
    const result = await monitorLock(address, 0n);
    return result.confirmations >= requiredConfs;
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
