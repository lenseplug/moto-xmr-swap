/**
 * SQLite persistence layer for swap records and state history.
 * Uses sql.js (pure WASM) — no native compilation required.
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
    type ICreateSwapParams,
    type IStateHistoryEntry,
    type ISwapRecord,
    type IUpdateSwapParams,
    SwapStatus,
    SETTLED_STATES,
} from './types.js';
import { encryptIfPresent, decryptIfPresent } from './encryption.js';

/** Fields that are encrypted at rest. */
const ENCRYPTED_FIELDS: ReadonlySet<string> = new Set([
    'preimage',
    'claim_token',
    'alice_view_key',
    'bob_view_key',
    'bob_spend_key',
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

/** Singleton SQLite storage service backed by sql.js WASM. */
export class StorageService {
    private static instance: StorageService | null = null;
    private db: Database | null = null;
    private readonly dbPath: string;
    private SQL: SqlJsStatic | null = null;
    private saveTimer: NodeJS.Timeout | null = null;
    private backupTimer: NodeJS.Timeout | null = null;

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
                params.alice_xmr_payout ?? null,
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
        if (updates.alice_xmr_payout !== undefined) {
            setClauses.push('alice_xmr_payout = ?');
            values.push(updates.alice_xmr_payout);
        }
        if (updates.sweep_status !== undefined) {
            setClauses.push('sweep_status = ?');
            values.push(updates.sweep_status ?? null);
        }

        if (setClauses.length > 1) {
            values.push(swapId);
            this.exec(
                `UPDATE swaps SET ${setClauses.join(', ')} WHERE swap_id = ?`,
                values,
            );
            this.scheduleSave();
        }

        if (updates.status !== undefined && fromState !== undefined) {
            this.recordStateHistory(swapId, fromState, updates.status, metadata);
        }

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
        return rows[0] as unknown as ISwapRecord;
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
        return rows as unknown as ISwapRecord[];
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
        return rows as unknown as ISwapRecord[];
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
        return rows as unknown as ISwapRecord[];
    }

    /**
     * Returns completed swaps whose sweep failed and need retry.
     * Matches sweep_status starting with 'failed:' or 'pending'.
     */
    public getFailedSweeps(): ISwapRecord[] {
        const rows = this.query(
            `SELECT * FROM swaps WHERE status = ? AND (sweep_status LIKE 'failed:%' OR sweep_status = 'pending' OR (sweep_status IS NULL AND trustless_mode = 1)) ORDER BY updated_at ASC LIMIT 20`,
            [SwapStatus.COMPLETED],
        );
        return rows as unknown as ISwapRecord[];
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

    private async initialize(): Promise<void> {
        this.SQL = await initSqlJs();

        if (existsSync(this.dbPath)) {
            const fileData = readFileSync(this.dbPath);
            this.db = new this.SQL.Database(fileData);
        } else {
            this.db = new this.SQL.Database();
        }

        this.exec(CREATE_SWAPS_TABLE);
        this.exec(CREATE_STATE_HISTORY_TABLE);
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

    private migrateAddColumn(table: string, column: string, type: string): void {
        try {
            this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        } catch {
            // Column already exists — ignore
        }
    }

    private migrateAddColumnWithDefault(table: string, column: string, type: string, defaultVal: string): void {
        try {
            this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} DEFAULT ${defaultVal}`);
        } catch {
            // Column already exists — ignore
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

    private scheduleSave(): void {
        setImmediate(() => {
            this.persistToDisk();
        });
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
            writeFileSync(backupPath, data);
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
            writeFileSync(this.dbPath, data);
        } catch (err: unknown) {
            if (err instanceof Error) {
                console.error(`[Storage] Failed to persist database: ${err.message}`);
            }
        }
    }
}
