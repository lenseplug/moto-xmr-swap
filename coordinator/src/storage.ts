/**
 * SQLite persistence layer for swap records and state history.
 * Uses sql.js (pure WASM) — no native compilation required.
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, openSync, closeSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join, dirname } from 'node:path';
import {
    type ICreateSwapParams,
    type IStateHistoryEntry,
    type ISwapRecord,
    type IUpdateSwapParams,
    SwapStatus,
    SETTLED_STATES,
} from './types.js';
import { encryptIfPresent, decryptIfPresent, canDecrypt, isEncryptionEnabled, computeHmac } from './encryption.js';

/** Fields that are encrypted at rest. */
const ENCRYPTED_FIELDS: ReadonlySet<string> = new Set([
    'preimage',
    'claim_token',
    'alice_view_key',
    'bob_view_key',
    'bob_spend_key',
    'alice_xmr_payout',
    'recovery_token',
]);

const CREATE_SWAPS_TABLE = `
CREATE TABLE IF NOT EXISTS swaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    swap_id TEXT UNIQUE NOT NULL,
    hash_lock TEXT NOT NULL,
    preimage TEXT,
    refund_block INTEGER NOT NULL,
    moto_amount TEXT NOT NULL,
    xmr_amount TEXT NOT NULL,
    xmr_fee TEXT NOT NULL DEFAULT '0',
    xmr_total TEXT NOT NULL DEFAULT '0',
    xmr_address TEXT,
    depositor TEXT NOT NULL,
    counterparty TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    opnet_create_tx TEXT,
    opnet_claim_tx TEXT,
    opnet_refund_tx TEXT,
    xmr_lock_tx TEXT,
    xmr_lock_confirmations INTEGER DEFAULT 0,
    xmr_subaddr_index INTEGER,
    claim_token TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
`;

const CREATE_STATE_HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS state_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    swap_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')),
    metadata TEXT
);
`;

const CREATE_SECRET_BACKUP_TABLE = `
CREATE TABLE IF NOT EXISTS secret_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash_lock TEXT UNIQUE NOT NULL,
    preimage TEXT NOT NULL,
    alice_view_key TEXT,
    alice_xmr_payout TEXT,
    applied INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);
`;

const CREATE_PENDING_PREIMAGES_TABLE = `
CREATE TABLE IF NOT EXISTS pending_preimages (
    swap_id TEXT PRIMARY KEY NOT NULL,
    preimage TEXT NOT NULL,
    stored_at TEXT DEFAULT (datetime('now'))
);
`;

const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_swaps_status ON swaps (status);
CREATE INDEX IF NOT EXISTS idx_history_swap_id ON state_history (swap_id);
`;

/** Row returned from a sql.js query — values are positional. */
type SqlRow = (string | number | null | Uint8Array)[];

/**
 * Converts a sql.js result row into a plain object using column names.
 * Decrypts encrypted fields transparently.
 */
function rowToObject(columns: string[], row: SqlRow): Record<string, string | number | null> {
    const obj: Record<string, string | number | null> = {};
    for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const val = row[i];
        if (col !== undefined) {
            let resolved = val instanceof Uint8Array ? null : (val ?? null);
            // Decrypt encrypted fields
            if (ENCRYPTED_FIELDS.has(col) && typeof resolved === 'string') {
                resolved = decryptIfPresent(resolved);
            }
            obj[col] = resolved;
        }
    }
    return obj;
}

/**
 * Safely maps a raw DB row to ISwapRecord with defaults for missing columns.
 * Protects against migration gaps where new columns don't exist yet in old DBs.
 */
function mapRowToSwapRecord(row: Record<string, string | number | null>): ISwapRecord {
    return {
        id: (row['id'] as number) ?? 0,
        swap_id: (row['swap_id'] as string) ?? '',
        hash_lock: (row['hash_lock'] as string) ?? '',
        preimage: (row['preimage'] as string | null) ?? null,
        refund_block: (row['refund_block'] as number) ?? 0,
        moto_amount: (row['moto_amount'] as string) ?? '0',
        xmr_amount: (row['xmr_amount'] as string) ?? '0',
        xmr_fee: (row['xmr_fee'] as string) ?? '0',
        xmr_total: (row['xmr_total'] as string) ?? '0',
        xmr_address: (row['xmr_address'] as string | null) ?? null,
        depositor: (row['depositor'] as string) ?? '',
        counterparty: (row['counterparty'] as string | null) ?? null,
        status: (row['status'] as SwapStatus) ?? SwapStatus.OPEN,
        opnet_create_tx: (row['opnet_create_tx'] as string | null) ?? null,
        opnet_claim_tx: (row['opnet_claim_tx'] as string | null) ?? null,
        opnet_refund_tx: (row['opnet_refund_tx'] as string | null) ?? null,
        xmr_lock_tx: (row['xmr_lock_tx'] as string | null) ?? null,
        xmr_lock_confirmations: (row['xmr_lock_confirmations'] as number) ?? 0,
        xmr_subaddr_index: (row['xmr_subaddr_index'] as number | null) ?? null,
        claim_token: (row['claim_token'] as string | null) ?? null,
        trustless_mode: (row['trustless_mode'] as number) ?? 0,
        alice_ed25519_pub: (row['alice_ed25519_pub'] as string | null) ?? null,
        alice_view_key: (row['alice_view_key'] as string | null) ?? null,
        bob_ed25519_pub: (row['bob_ed25519_pub'] as string | null) ?? null,
        bob_view_key: (row['bob_view_key'] as string | null) ?? null,
        bob_spend_key: (row['bob_spend_key'] as string | null) ?? null,
        bob_dleq_proof: (row['bob_dleq_proof'] as string | null) ?? null,
        alice_secp256k1_pub: (row['alice_secp256k1_pub'] as string | null) ?? null,
        alice_dleq_proof: (row['alice_dleq_proof'] as string | null) ?? null,
        bob_secp256k1_pub: (row['bob_secp256k1_pub'] as string | null) ?? null,
        alice_xmr_payout: (row['alice_xmr_payout'] as string | null) ?? null,
        xmr_sweep_tx: (row['xmr_sweep_tx'] as string | null) ?? null,
        xmr_sweep_confirmations: (row['xmr_sweep_confirmations'] as number) ?? 0,
        sweep_status: (row['sweep_status'] as string | null) ?? null,
        xmr_deposit_height: (row['xmr_deposit_height'] as number | null) ?? null,
        recovery_token: (row['recovery_token'] as string | null) ?? null,
        created_at: (row['created_at'] as string) ?? '',
        updated_at: (row['updated_at'] as string) ?? '',
    };
}

/** Singleton SQLite storage service backed by sql.js WASM. */
export class StorageService {
    private static instance: StorageService | null = null;
    private db: Database | null = null;
    private readonly dbPath: string;
    private SQL: SqlJsStatic | null = null;
    private saveTimer: NodeJS.Timeout | null = null;
    private backupTimer: NodeJS.Timeout | null = null;
    private lockFilePath: string | null = null;

    private constructor(dbPath: string) {
        this.dbPath = dbPath;
    }

    /**
     * Returns the singleton StorageService, creating and initializing it if necessary.
     * This method must be awaited before any other methods are called.
     * @param dbPath - Path to the SQLite database file.
     */
    public static async getInstance(dbPath = 'coordinator.db'): Promise<StorageService> {
        if (!StorageService.instance) {
            StorageService.instance = new StorageService(dbPath);
            await StorageService.instance.initialize();
        }
        return StorageService.instance;
    }

    /** Gracefully closes the database, flushing to disk. */
    public close(): void {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
        }
        if (this.backupTimer) {
            clearInterval(this.backupTimer);
        }
        this.persistToDisk();
        this.db?.close();
        // Release lockfile
        if (this.lockFilePath) {
            try { unlinkSync(this.lockFilePath); } catch { /* best effort */ }
            this.lockFilePath = null;
        }
        StorageService.instance = null;
    }

    /**
     * Creates a new swap record.
     * @param params - Swap creation parameters.
     * @returns The newly created swap record.
     */
    public createSwap(params: ICreateSwapParams): ISwapRecord {
        this.exec(
            `INSERT INTO swaps
                (swap_id, hash_lock, refund_block, moto_amount, xmr_amount, xmr_fee, xmr_total, xmr_address, depositor, opnet_create_tx, alice_xmr_payout)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                params.swap_id,
                params.hash_lock,
                params.refund_block,
                params.moto_amount,
                params.xmr_amount,
                params.xmr_fee,
                params.xmr_total,
                params.xmr_address ?? null,
                params.depositor,
                params.opnet_create_tx ?? null,
                params.alice_xmr_payout ? (encryptIfPresent(params.alice_xmr_payout) ?? params.alice_xmr_payout) : null,
            ],
        );
        this.scheduleSave();

        const created = this.getSwap(params.swap_id);
        if (!created) {
            throw new Error(`Failed to retrieve swap after creation: ${params.swap_id}`);
        }
        return created;
    }

    /**
     * Updates mutable fields on a swap record.
     * @param swapId - The swap identifier.
     * @param updates - Fields to update.
     * @param fromState - Previous state (for history logging).
     * @param metadata - Optional metadata string for the history entry.
     */
    public updateSwap(
        swapId: string,
        updates: IUpdateSwapParams,
        fromState?: SwapStatus,
        metadata?: string,
    ): ISwapRecord {
        // Wrap in transaction: status update + state history must be atomic.
        // Without this, a crash between UPDATE and INSERT could leave the DB
        // with a status change but no history record (or vice versa).
        this.exec('BEGIN IMMEDIATE');
        try {
            return this.doUpdateSwap(swapId, updates, fromState, metadata);
        } catch (err) {
            this.exec('ROLLBACK');
            throw err;
        }
    }

    private doUpdateSwap(
        swapId: string,
        updates: IUpdateSwapParams,
        fromState?: SwapStatus,
        metadata?: string,
    ): ISwapRecord {
        const setClauses: string[] = [`updated_at = datetime('now')`];
        const values: (string | number | null)[] = [];

        if (updates.status !== undefined) {
            setClauses.push('status = ?');
            values.push(updates.status);
        }
        if (updates.preimage !== undefined) {
            setClauses.push('preimage = ?');
            values.push(encryptIfPresent(updates.preimage) ?? null);
        }
        if (updates.counterparty !== undefined) {
            setClauses.push('counterparty = ?');
            values.push(updates.counterparty);
        }
        if (updates.opnet_claim_tx !== undefined) {
            setClauses.push('opnet_claim_tx = ?');
            values.push(updates.opnet_claim_tx);
        }
        if (updates.opnet_refund_tx !== undefined) {
            setClauses.push('opnet_refund_tx = ?');
            values.push(updates.opnet_refund_tx);
        }
        if (updates.xmr_lock_tx !== undefined) {
            setClauses.push('xmr_lock_tx = ?');
            values.push(updates.xmr_lock_tx);
        }
        if (updates.xmr_lock_confirmations !== undefined) {
            setClauses.push('xmr_lock_confirmations = ?');
            values.push(updates.xmr_lock_confirmations);
        }
        if (updates.xmr_address !== undefined) {
            setClauses.push('xmr_address = ?');
            values.push(updates.xmr_address);
        }
        if (updates.xmr_subaddr_index !== undefined) {
            setClauses.push('xmr_subaddr_index = ?');
            values.push(updates.xmr_subaddr_index);
        }
        if (updates.claim_token !== undefined) {
            setClauses.push('claim_token = ?');
            values.push(encryptIfPresent(updates.claim_token) ?? null);
            // Auto-compute HMAC for O(1) indexed lookup
            setClauses.push('claim_token_hmac = ?');
            values.push(updates.claim_token ? (computeHmac(updates.claim_token) ?? null) : null);
        }
        if (updates.trustless_mode !== undefined) {
            setClauses.push('trustless_mode = ?');
            values.push(updates.trustless_mode);
        }
        if (updates.alice_ed25519_pub !== undefined) {
            setClauses.push('alice_ed25519_pub = ?');
            values.push(updates.alice_ed25519_pub);
        }
        if (updates.alice_view_key !== undefined) {
            setClauses.push('alice_view_key = ?');
            values.push(encryptIfPresent(updates.alice_view_key) ?? null);
        }
        if (updates.bob_ed25519_pub !== undefined) {
            setClauses.push('bob_ed25519_pub = ?');
            values.push(updates.bob_ed25519_pub);
        }
        if (updates.bob_view_key !== undefined) {
            setClauses.push('bob_view_key = ?');
            values.push(encryptIfPresent(updates.bob_view_key) ?? null);
        }
        if (updates.bob_spend_key !== undefined) {
            setClauses.push('bob_spend_key = ?');
            values.push(encryptIfPresent(updates.bob_spend_key) ?? null);
        }
        if (updates.bob_dleq_proof !== undefined) {
            setClauses.push('bob_dleq_proof = ?');
            values.push(updates.bob_dleq_proof);
        }
        if (updates.alice_secp256k1_pub !== undefined) {
            setClauses.push('alice_secp256k1_pub = ?');
            values.push(updates.alice_secp256k1_pub);
        }
        if (updates.alice_dleq_proof !== undefined) {
            setClauses.push('alice_dleq_proof = ?');
            values.push(updates.alice_dleq_proof);
        }
        if (updates.bob_secp256k1_pub !== undefined) {
            setClauses.push('bob_secp256k1_pub = ?');
            values.push(updates.bob_secp256k1_pub);
        }
        if (updates.alice_xmr_payout !== undefined) {
            setClauses.push('alice_xmr_payout = ?');
            values.push(encryptIfPresent(updates.alice_xmr_payout) ?? null);
        }
        if (updates.xmr_sweep_tx !== undefined) {
            setClauses.push('xmr_sweep_tx = ?');
            values.push(updates.xmr_sweep_tx ?? null);
        }
        if (updates.xmr_sweep_confirmations !== undefined) {
            setClauses.push('xmr_sweep_confirmations = ?');
            values.push(updates.xmr_sweep_confirmations);
        }
        if (updates.sweep_status !== undefined) {
            setClauses.push('sweep_status = ?');
            values.push(updates.sweep_status ?? null);
        }
        if (updates.xmr_deposit_height !== undefined) {
            setClauses.push('xmr_deposit_height = ?');
            values.push(updates.xmr_deposit_height ?? null);
        }
        if (updates.recovery_token !== undefined) {
            setClauses.push('recovery_token = ?');
            values.push(encryptIfPresent(updates.recovery_token) ?? null);
        }

        if (setClauses.length > 1) {
            values.push(swapId);
            // Optimistic concurrency: when fromState is specified, only update if
            // the current status still matches. Prevents TOCTOU state overwrites.
            if (fromState !== undefined) {
                values.push(fromState);
                this.exec(
                    `UPDATE swaps SET ${setClauses.join(', ')} WHERE swap_id = ? AND status = ?`,
                    values,
                );
                // Verify the update actually affected a row
                const verifyRows = this.query(
                    'SELECT changes() as cnt',
                );
                const changesCount = (verifyRows[0] as Record<string, number | null> | undefined)?.['cnt'] ?? 0;
                if (changesCount === 0) {
                    const current = this.getSwap(swapId);
                    throw new Error(
                        `Optimistic concurrency conflict: swap ${swapId} expected status ${fromState} but is ${current?.status ?? 'unknown'}`,
                    );
                }
            } else {
                this.exec(
                    `UPDATE swaps SET ${setClauses.join(', ')} WHERE swap_id = ?`,
                    values,
                );
            }
            this.scheduleSave();
        }

        if (updates.status !== undefined && fromState !== undefined) {
            this.recordStateHistory(swapId, fromState, updates.status, metadata);
        }

        this.exec('COMMIT');

        const updated = this.getSwap(swapId);
        if (!updated) {
            throw new Error(`Swap not found after update: ${swapId}`);
        }
        return updated;
    }

    /**
     * Retrieves a single swap by its identifier.
     * @param swapId - The swap identifier.
     * @returns The swap record or null if not found.
     */
    public getSwap(swapId: string): ISwapRecord | null {
        const rows = this.query('SELECT * FROM swaps WHERE swap_id = ?', [swapId]);
        if (rows.length === 0) return null;
        return mapRowToSwapRecord(rows[0] as Record<string, string | number | null>);
    }

    /**
     * Retrieves a swap by its hash_lock value.
     * @param hashLock - The hash lock hex string.
     * @returns The swap record or null if not found.
     */
    public getSwapByHashLock(hashLock: string): ISwapRecord | null {
        const rows = this.query('SELECT * FROM swaps WHERE hash_lock = ?', [hashLock.toLowerCase()]);
        if (rows.length === 0) return null;
        return mapRowToSwapRecord(rows[0] as Record<string, string | number | null>);
    }

    /**
     * Retrieves a swap by its claim_token value.
     * Uses HMAC-SHA256 index for O(1) lookup when encryption is enabled,
     * with a verification step (decrypt + timing-safe compare) to confirm.
     * Falls back to O(n) scan for unencrypted/legacy data.
     * @param claimToken - The raw claim token hex string.
     * @returns The swap record or null if not found.
     */
    public getSwapByClaimToken(claimToken: string): ISwapRecord | null {
        // Fast path: HMAC-indexed lookup (O(1) via indexed column)
        const hmac = computeHmac(claimToken);
        if (hmac) {
            const rows = this.query('SELECT * FROM swaps WHERE claim_token_hmac = ?', [hmac]);
            for (const row of rows) {
                const record = mapRowToSwapRecord(row as Record<string, string | number | null>);
                // Verify with timing-safe comparison after decryption (defense against HMAC collision)
                if (record.claim_token !== null) {
                    const expected = Buffer.from(record.claim_token, 'utf-8');
                    const provided = Buffer.from(claimToken, 'utf-8');
                    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
                        return record;
                    }
                }
            }
            return null;
        }
        // Fallback: O(n) scan for unencrypted mode (dev only)
        const rows = this.query('SELECT * FROM swaps WHERE claim_token IS NOT NULL');
        for (const row of rows) {
            const record = mapRowToSwapRecord(row as Record<string, string | number | null>);
            if (record.claim_token !== null) {
                const expected = Buffer.from(record.claim_token, 'utf-8');
                const provided = Buffer.from(claimToken, 'utf-8');
                if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
                    return record;
                }
            }
        }
        return null;
    }

    /**
     * Returns all swaps not in a terminal state.
     */
    public getActiveSwaps(): ISwapRecord[] {
        const settledList = Array.from(SETTLED_STATES)
            .map(() => '?')
            .join(', ');
        const sql = `SELECT * FROM swaps WHERE status NOT IN (${settledList}) ORDER BY created_at DESC`;
        const rows = this.query(sql, Array.from(SETTLED_STATES));
        return rows.map((r) => mapRowToSwapRecord(r as Record<string, string | number | null>));
    }

    /**
     * Returns all swaps with a given status.
     * @param status - The status to filter by.
     */
    public getSwapsByStatus(status: SwapStatus): ISwapRecord[] {
        const rows = this.query(
            'SELECT * FROM swaps WHERE status = ? ORDER BY created_at DESC',
            [status],
        );
        return rows.map((r) => mapRowToSwapRecord(r as Record<string, string | number | null>));
    }

    /**
     * Returns swaps that were interrupted (non-terminal states).
     * Used at startup to resume monitoring.
     */
    public listInterruptedSwaps(): ISwapRecord[] {
        return this.getActiveSwaps();
    }

    /**
     * Returns a paginated list of all swaps.
     * @param page - 1-based page number.
     * @param limit - Items per page.
     */
    public listSwaps(page: number, limit: number): ISwapRecord[] {
        const offset = (page - 1) * limit;
        const rows = this.query(
            'SELECT * FROM swaps ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [limit, offset],
        );
        return rows.map((r) => mapRowToSwapRecord(r as Record<string, string | number | null>));
    }

    /**
     * Returns completed swaps whose sweep failed and need retry.
     * Matches sweep_status starting with 'failed:' or 'pending'.
     * Sweeps are now automatic — no manual claim needed.
     */
    public getFailedSweeps(): ISwapRecord[] {
        const rows = this.query(
            `SELECT * FROM swaps WHERE (status = ? OR status = ?) AND (sweep_status LIKE 'failed:%' OR sweep_status = 'pending' OR sweep_status = 'sweeping') ORDER BY updated_at ASC LIMIT 20`,
            [SwapStatus.COMPLETED, SwapStatus.XMR_SWEEPING],
        );
        return rows.map((r) => mapRowToSwapRecord(r as Record<string, string | number | null>));
    }

    /**
     * Returns expired swaps whose XMR refund sweep failed and need retry.
     * Only matches refund-specific statuses to prevent cross-contamination
     * with normal Alice sweeps (which use 'pending'/'failed:').
     */
    public getFailedRefundSweeps(): ISwapRecord[] {
        const rows = this.query(
            `SELECT * FROM swaps WHERE status = ? AND (sweep_status LIKE 'refund_failed:%' OR sweep_status = 'refund_pending') ORDER BY updated_at ASC LIMIT 20`,
            [SwapStatus.EXPIRED],
        );
        return rows.map((r) => mapRowToSwapRecord(r as Record<string, string | number | null>));
    }

    /**
     * Returns state history for a swap ordered by timestamp ascending.
     * @param swapId - The swap identifier.
     */
    public getStateHistory(swapId: string): IStateHistoryEntry[] {
        const rows = this.query(
            'SELECT * FROM state_history WHERE swap_id = ? ORDER BY timestamp ASC',
            [swapId],
        );
        return rows as unknown as IStateHistoryEntry[];
    }

    /**
     * Stores a secret backup keyed by hashLock. Called before the swap exists on-chain.
     * If a backup for this hashLock already exists, it's a no-op.
     */
    public backupSecret(hashLock: string, preimage: string, aliceViewKey?: string | null, aliceXmrPayout?: string | null, recoveryToken?: string | null): void {
        const existing = this.query('SELECT id FROM secret_backups WHERE hash_lock = ?', [hashLock]);
        if (existing.length > 0) return;
        this.exec(
            `INSERT INTO secret_backups (hash_lock, preimage, alice_view_key, alice_xmr_payout, recovery_token) VALUES (?, ?, ?, ?, ?)`,
            [hashLock, encryptIfPresent(preimage) ?? preimage, aliceViewKey ? (encryptIfPresent(aliceViewKey) ?? aliceViewKey) : null, aliceXmrPayout ? (encryptIfPresent(aliceXmrPayout) ?? aliceXmrPayout) : null, recoveryToken ? (encryptIfPresent(recoveryToken) ?? recoveryToken) : null],
        );
        this.scheduleSave();
        console.log(`[Storage] Secret backed up for hashLock ${hashLock.slice(0, 16)}...`);
    }

    /**
     * Retrieves a secret backup by hashLock (decrypts sensitive fields).
     * Returns null if not found.
     */
    public getSecretBackup(hashLock: string): { preimage: string; aliceViewKey: string | null; aliceXmrPayout: string | null; recoveryToken: string | null } | null {
        // Note: query() -> rowToObject() already decrypts ENCRYPTED_FIELDS transparently.
        // Do NOT call decryptIfPresent again here — that causes double-decryption and
        // spurious "Found unencrypted value in DB" warnings.
        const rows = this.query('SELECT preimage, alice_view_key, alice_xmr_payout, recovery_token FROM secret_backups WHERE hash_lock = ?', [hashLock]);
        if (rows.length === 0) return null;
        const row = rows[0] as { preimage: string; alice_view_key: string | null; alice_xmr_payout: string | null; recovery_token: string | null };
        return {
            preimage: row.preimage ?? '',
            aliceViewKey: row.alice_view_key ?? null,
            aliceXmrPayout: row.alice_xmr_payout ?? null,
            recoveryToken: row.recovery_token ?? null,
        };
    }

    // -----------------------------------------------------------------------
    // Pending preimage persistence (survives eviction + crash)
    // -----------------------------------------------------------------------

    /** Persists a preimage to DB (backup for in-memory WebSocket queue). */
    public savePendingPreimage(swapId: string, preimage: string): void {
        this.exec(
            `INSERT OR REPLACE INTO pending_preimages (swap_id, preimage) VALUES (?, ?)`,
            [swapId, encryptIfPresent(preimage) ?? preimage],
        );
        this.scheduleSave();
    }

    /** Removes a persisted pending preimage (after delivery or swap completion). */
    public deletePendingPreimage(swapId: string): void {
        this.exec('DELETE FROM pending_preimages WHERE swap_id = ?', [swapId]);
        this.scheduleSave();
    }

    /** Loads all persisted pending preimages (for startup recovery). */
    public loadPendingPreimages(): Array<{ swapId: string; preimage: string }> {
        // Note: query() -> rowToObject() already decrypts ENCRYPTED_FIELDS transparently.
        const rows = this.query('SELECT swap_id, preimage FROM pending_preimages');
        const result: Array<{ swapId: string; preimage: string }> = [];
        for (const row of rows) {
            const rec = row as { swap_id: string; preimage: string };
            result.push({ swapId: rec.swap_id, preimage: rec.preimage });
        }
        return result;
    }

    /** Loads a single persisted pending preimage by swapId (avoids full-table scan). */
    public loadPendingPreimage(swapId: string): string | null {
        const rows = this.query('SELECT preimage FROM pending_preimages WHERE swap_id = ?', [swapId]);
        if (rows.length === 0) return null;
        const rec = rows[0] as { preimage: string };
        return rec.preimage ?? null;
    }

    /**
     * Marks a secret backup as applied (consumed by a swap).
     */
    public markSecretBackupApplied(hashLock: string): void {
        this.exec('UPDATE secret_backups SET applied = 1 WHERE hash_lock = ?', [hashLock]);
        this.scheduleSave();
    }

    private async initialize(): Promise<void> {
        // Acquire exclusive lock to prevent concurrent coordinator instances
        this.lockFilePath = `${this.dbPath}.lock`;
        try {
            const fd = openSync(this.lockFilePath, 'wx');
            writeFileSync(fd, `pid=${process.pid}\nstarted=${new Date().toISOString()}\n`);
            closeSync(fd);
        } catch (err: unknown) {
            const msg = err instanceof Error ? (err as NodeJS.ErrnoException).code : String(err);
            if (msg === 'EEXIST') {
                // Lock file exists — check if the owning process is still alive.
                let lockInfo = '';
                try { lockInfo = readFileSync(this.lockFilePath, 'utf-8').trim(); } catch { /* ignore */ }

                // Try to extract PID from lock file and check if it's still running.
                const pidMatch = lockInfo.match(/pid=(\d+)/);
                if (pidMatch) {
                    const lockPid = parseInt(pidMatch[1] as string, 10);
                    let processAlive = false;
                    try {
                        // kill(pid, 0) checks if process exists without sending a signal
                        process.kill(lockPid, 0);
                        processAlive = true;
                    } catch {
                        // Process doesn't exist — stale lock file from a crash
                        processAlive = false;
                    }

                    if (!processAlive) {
                        console.warn(
                            `[Storage] Stale lock file detected (PID ${lockPid} is no longer running). Overwriting and continuing.`,
                        );
                        // Atomic overwrite: eliminates the race window between unlinkSync + openSync('wx')
                        // where another process could grab the lock in between.
                        writeFileSync(this.lockFilePath, `pid=${process.pid}\nstarted=${new Date().toISOString()}\n`);
                    } else {
                        console.error(
                            `[Storage] FATAL: Lock file exists at ${this.lockFilePath}\n` +
                            `[Storage] Another coordinator instance (PID ${lockPid}) is running. Lock info: ${lockInfo}\n` +
                            `[Storage] Stop the other instance first, or delete the lock file if you're sure it's stale.`,
                        );
                        process.exit(1);
                    }
                } else {
                    // Can't determine PID — fall back to manual resolution
                    console.error(
                        `[Storage] FATAL: Lock file exists at ${this.lockFilePath}\n` +
                        `[Storage] Another coordinator instance may be running. Lock info: ${lockInfo}\n` +
                        `[Storage] If the previous instance crashed, delete the lock file manually and restart.`,
                    );
                    process.exit(1);
                }
            }
            throw err; // Re-throw unexpected errors (permissions, etc.)
        }

        this.SQL = await initSqlJs();

        if (existsSync(this.dbPath)) {
            const fileData = readFileSync(this.dbPath);
            this.db = new this.SQL.Database(fileData);
        } else {
            this.db = new this.SQL.Database();
        }

        this.exec(CREATE_SWAPS_TABLE);
        this.exec(CREATE_STATE_HISTORY_TABLE);
        this.exec(CREATE_SECRET_BACKUP_TABLE);
        this.exec(CREATE_PENDING_PREIMAGES_TABLE);
        this.exec(CREATE_INDEXES);

        // Migrations: add columns if missing (existing DBs)
        this.migrateAddColumn('swaps', 'claim_token', 'TEXT');
        this.migrateAddColumn('swaps', 'xmr_subaddr_index', 'INTEGER');
        // Trustless mode columns
        this.migrateAddColumnWithDefault('swaps', 'trustless_mode', 'INTEGER', '0');
        this.migrateAddColumn('swaps', 'alice_ed25519_pub', 'TEXT');
        this.migrateAddColumn('swaps', 'alice_view_key', 'TEXT');
        this.migrateAddColumn('swaps', 'bob_ed25519_pub', 'TEXT');
        this.migrateAddColumn('swaps', 'bob_view_key', 'TEXT');
        this.migrateAddColumn('swaps', 'bob_dleq_proof', 'TEXT');
        this.migrateAddColumn('swaps', 'bob_spend_key', 'TEXT');
        this.migrateAddColumn('swaps', 'alice_xmr_payout', 'TEXT');
        this.migrateAddColumn('swaps', 'sweep_status', 'TEXT');
        this.migrateAddColumn('swaps', 'recovery_token', 'TEXT');
        // Cross-curve DLEQ proof columns
        this.migrateAddColumn('swaps', 'alice_secp256k1_pub', 'TEXT');
        this.migrateAddColumn('swaps', 'alice_dleq_proof', 'TEXT');
        this.migrateAddColumn('swaps', 'bob_secp256k1_pub', 'TEXT');
        // Sweep-before-claim columns
        this.migrateAddColumn('swaps', 'xmr_sweep_tx', 'TEXT');
        this.migrateAddColumnWithDefault('swaps', 'xmr_sweep_confirmations', 'INTEGER', '0');
        // Add recovery_token column to secret_backups (if not exists)
        this.migrateAddColumn('secret_backups', 'recovery_token', 'TEXT');
        // Deposit height for accurate sweep restore_height
        this.migrateAddColumn('swaps', 'xmr_deposit_height', 'INTEGER');
        // HMAC index for O(1) claim_token lookup (avoids full table scan with AES decryption)
        this.migrateAddColumn('swaps', 'claim_token_hmac', 'TEXT');
        this.exec('CREATE INDEX IF NOT EXISTS idx_swaps_claim_token_hmac ON swaps (claim_token_hmac)');
        // Clear stale HMACs so they get re-derived with the current HMAC key (HKDF migration).
        // This is safe: old HMACs become invalid when the HMAC key changes, and backfill re-derives them.
        if (isEncryptionEnabled()) {
            this.exec('UPDATE swaps SET claim_token_hmac = NULL WHERE claim_token_hmac IS NOT NULL');
        }
        // Backfill HMAC for existing swaps that have claim_token but no HMAC
        this.backfillClaimTokenHmac();

        this.saveTimer = setInterval(() => {
            this.persistToDisk();
        }, 5000);

        // Periodic database backup
        const backupIntervalMs = parseInt(process.env['DB_BACKUP_INTERVAL_MS'] ?? '3600000', 10); // default: 1 hour
        const maxBackups = parseInt(process.env['DB_MAX_BACKUPS'] ?? '24', 10); // keep last 24
        if (backupIntervalMs > 0) {
            // Run first backup shortly after startup (10s delay)
            setTimeout(() => this.createBackup(maxBackups), 10_000);
            this.backupTimer = setInterval(() => this.createBackup(maxBackups), backupIntervalMs);
            console.log(`[Storage] Backup enabled: every ${backupIntervalMs / 1000}s, keeping ${maxBackups} copies`);
        }
    }

    /**
     * Backfills claim_token_hmac for existing rows that have claim_token but no HMAC.
     * Runs at startup after migration to ensure the HMAC index is complete.
     */
    private backfillClaimTokenHmac(): void {
        const rows = this.query('SELECT swap_id, claim_token FROM swaps WHERE claim_token IS NOT NULL AND claim_token_hmac IS NULL');
        if (rows.length === 0) return;
        let filled = 0;
        for (const row of rows) {
            const record = row as { swap_id: string; claim_token: string };
            const decrypted = decryptIfPresent(record.claim_token);
            if (decrypted) {
                const hmac = computeHmac(decrypted);
                if (hmac) {
                    this.exec('UPDATE swaps SET claim_token_hmac = ? WHERE swap_id = ?', [hmac, record.swap_id]);
                    filled++;
                }
            }
        }
        if (filled > 0) {
            console.log(`[Storage] Backfilled claim_token_hmac for ${filled} existing swaps`);
            this.scheduleSave();
        }
    }

    /** Validate DDL identifiers to prevent SQL injection in migration methods. */
    private static readonly SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    private static readonly SAFE_DEFAULT = /^[0-9]+$|^'[^']*'$|^NULL$/i;

    private migrateAddColumn(table: string, column: string, type: string): void {
        if (!StorageService.SAFE_IDENTIFIER.test(table) || !StorageService.SAFE_IDENTIFIER.test(column) || !StorageService.SAFE_IDENTIFIER.test(type)) {
            throw new Error(`Unsafe DDL identifier in migrateAddColumn: ${table}.${column} ${type}`);
        }
        try {
            this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            // Only suppress "duplicate column" — re-throw unexpected errors
            if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                throw err;
            }
        }
    }

    private migrateAddColumnWithDefault(table: string, column: string, type: string, defaultVal: string): void {
        if (!StorageService.SAFE_IDENTIFIER.test(table) || !StorageService.SAFE_IDENTIFIER.test(column) || !StorageService.SAFE_IDENTIFIER.test(type)) {
            throw new Error(`Unsafe DDL identifier in migrateAddColumnWithDefault: ${table}.${column} ${type}`);
        }
        if (!StorageService.SAFE_DEFAULT.test(defaultVal)) {
            throw new Error(`Unsafe default value in migrateAddColumnWithDefault: ${defaultVal}`);
        }
        try {
            this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} DEFAULT ${defaultVal}`);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
                throw err;
            }
        }
    }

    private getDb(): Database {
        if (!this.db) {
            throw new Error('Database not initialized — call StorageService.getInstance() first');
        }
        return this.db;
    }

    private exec(sql: string, params: (string | number | null)[] = []): void {
        const db = this.getDb();
        db.run(sql, params);
    }

    private query(
        sql: string,
        params: (string | number | null)[] = [],
    ): Record<string, string | number | null>[] {
        const db = this.getDb();
        const results = db.exec(sql, params);
        if (results.length === 0) return [];

        const result = results[0];
        if (!result) return [];

        const { columns, values } = result;
        return values.map((row) => rowToObject(columns, row));
    }

    private recordStateHistory(
        swapId: string,
        fromState: SwapStatus,
        toState: SwapStatus,
        metadata?: string,
    ): void {
        this.exec(
            'INSERT INTO state_history (swap_id, from_state, to_state, metadata) VALUES (?, ?, ?, ?)',
            [swapId, fromState, toState, metadata ?? null],
        );
        // Prune old history entries (keep last 10,000 rows)
        this.exec(
            'DELETE FROM state_history WHERE id NOT IN (SELECT id FROM state_history ORDER BY id DESC LIMIT 10000)',
        );
        this.scheduleSave();
    }

    private savePending = false;
    private persistFailures = 0;
    private readonly MAX_PERSIST_FAILURES = 3;

    private scheduleSave(): void {
        if (this.savePending) return; // Deduplicate: only one pending save at a time
        this.savePending = true;
        setImmediate(() => {
            this.persistToDisk();
            this.savePending = false;
        });
    }

    /**
     * Synchronously persist to disk immediately. Use for critical state transitions
     * (money-movement states) where crash-loss would be dangerous.
     */
    public persistNow(): void {
        this.persistToDisk();
        this.savePending = false;
    }

    /**
     * Creates a timestamped backup of the database file.
     * Keeps the last `maxBackups` files, deleting older ones.
     */
    private createBackup(maxBackups: number): void {
        if (!this.db) return;
        try {
            const backupDir = join(dirname(this.dbPath), 'backups');
            mkdirSync(backupDir, { recursive: true });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = join(backupDir, `coordinator-${timestamp}.db`);

            const data = this.db.export();
            writeFileSync(backupPath, data, { mode: 0o600 });
            console.log(`[Storage] Backup created: ${backupPath} (${(data.length / 1024).toFixed(1)} KB)`);

            // Prune old backups
            const files = readdirSync(backupDir)
                .filter((f) => f.startsWith('coordinator-') && f.endsWith('.db'))
                .sort();
            while (files.length > maxBackups) {
                const oldest = files.shift();
                if (oldest) {
                    unlinkSync(join(backupDir, oldest));
                    console.log(`[Storage] Deleted old backup: ${oldest}`);
                }
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[Storage] Backup failed: ${msg}`);
        }
    }

    private persistToDisk(): void {
        if (!this.db) return;
        try {
            const data = this.db.export();
            // Atomic write: write to temp file, then rename (prevents half-written DB)
            const tmpPath = `${this.dbPath}.tmp`;
            writeFileSync(tmpPath, data, { mode: 0o600 });
            renameSync(tmpPath, this.dbPath);
            this.persistFailures = 0; // Reset on success
        } catch (err: unknown) {
            this.persistFailures++;
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.error(
                `[Storage] CRITICAL: Failed to persist database (${this.persistFailures}/${this.MAX_PERSIST_FAILURES}): ${msg}`,
            );
            if (this.persistFailures >= this.MAX_PERSIST_FAILURES) {
                console.error(
                    `[Storage] FATAL: ${this.MAX_PERSIST_FAILURES} consecutive persist failures. ` +
                    `In-memory state has diverged from disk. Shutting down to prevent data loss.`,
                );
                process.exit(1);
            }
        }
    }

    /**
     * Verifies that all encrypted fields in the DB can be decrypted with the current key.
     * Call at startup to detect ENCRYPTION_KEY rotation that would silently corrupt data.
     * Returns the number of corrupted rows found, or 0 if all is well.
     */
    public verifyEncryptionHealth(): number {
        if (!isEncryptionEnabled()) return 0; // No encryption, nothing to check

        const encFieldNames = [...ENCRYPTED_FIELDS];
        // Use raw db.exec() to bypass rowToObject's auto-decryption.
        // We need to test raw ciphertext values to verify decryptability.
        const db = this.getDb();
        const results = db.exec(
            `SELECT swap_id, ${encFieldNames.join(', ')} FROM swaps WHERE status NOT IN ('COMPLETED', 'REFUNDED') LIMIT 50`,
        );
        if (results.length === 0) return 0;

        const { columns, values } = results[0]!;
        let corrupted = 0;
        for (const row of values) {
            const swapIdIdx = columns.indexOf('swap_id');
            const swapId = (swapIdIdx >= 0 ? String(row[swapIdIdx]) : '?');
            for (const field of encFieldNames) {
                const idx = columns.indexOf(field);
                if (idx === -1) continue;
                const val = row[idx];
                if (val !== null && typeof val === 'string' && val.length > 0) {
                    if (!canDecrypt(val)) {
                        console.error(`[Storage] ENCRYPTION ERROR: swap ${swapId}, field '${field}' cannot be decrypted with current ENCRYPTION_KEY.`);
                        corrupted++;
                    }
                }
            }
        }
        return corrupted;
    }
}
