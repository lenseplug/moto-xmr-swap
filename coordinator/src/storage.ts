/**
 * SQLite persistence layer for swap records and state history.
 * Uses sql.js (pure WASM) — no native compilation required.
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
    type ICreateSwapParams,
    type IStateHistoryEntry,
    type ISwapRecord,
    type IUpdateSwapParams,
    SwapStatus,
    TERMINAL_STATES,
} from './types.js';

const CREATE_SWAPS_TABLE = `
CREATE TABLE IF NOT EXISTS swaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    swap_id TEXT UNIQUE NOT NULL,
    hash_lock TEXT NOT NULL,
    preimage TEXT,
    refund_block INTEGER NOT NULL,
    moto_amount TEXT NOT NULL,
    xmr_amount TEXT NOT NULL,
    xmr_address TEXT,
    depositor TEXT NOT NULL,
    counterparty TEXT,
    status TEXT NOT NULL DEFAULT 'OPEN',
    opnet_create_tx TEXT,
    opnet_claim_tx TEXT,
    opnet_refund_tx TEXT,
    xmr_lock_tx TEXT,
    xmr_lock_confirmations INTEGER DEFAULT 0,
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

/** Converts a sql.js result row into a plain object using column names. */
function rowToObject(columns: string[], row: SqlRow): Record<string, string | number | null> {
    const obj: Record<string, string | number | null> = {};
    for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const val = row[i];
        if (col !== undefined) {
            obj[col] = val instanceof Uint8Array ? null : (val ?? null);
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
                (swap_id, hash_lock, refund_block, moto_amount, xmr_amount, xmr_address, depositor, opnet_create_tx)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                params.swap_id,
                params.hash_lock,
                params.refund_block,
                params.moto_amount,
                params.xmr_amount,
                params.xmr_address ?? null,
                params.depositor,
                params.opnet_create_tx ?? null,
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
            values.push(updates.preimage);
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
        const terminalList = Array.from(TERMINAL_STATES)
            .map(() => '?')
            .join(', ');
        const sql = `SELECT * FROM swaps WHERE status NOT IN (${terminalList}) ORDER BY created_at DESC`;
        const rows = this.query(sql, Array.from(TERMINAL_STATES));
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

        this.saveTimer = setInterval(() => {
            this.persistToDisk();
        }, 5000);
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
        this.scheduleSave();
    }

    private scheduleSave(): void {
        setImmediate(() => {
            this.persistToDisk();
        });
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
