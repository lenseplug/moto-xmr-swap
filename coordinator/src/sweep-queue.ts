/**
 * FIFO sweep queue — serializes wallet-rpc operations.
 *
 * wallet-rpc is single-threaded (one wallet open at a time). This queue
 * ensures sweeps run one at a time while providing position visibility
 * to callers via onUpdate callbacks.
 *
 * Uses an async mutex (promise chain) instead of a boolean flag to prevent
 * the race condition where two processNext() invocations could overlap if
 * enqueue() fires between `processing = false` and the recursive call.
 */

/** A pending sweep job. */
export interface SweepJob {
    readonly swapId: string;
    readonly sweepArgs: {
        readonly spendKeyHex: string;
        readonly viewKeyHex: string;
        readonly lockAddress: string;
        readonly aliceAmountPiconero: bigint;
        readonly aliceAddress?: string;
        /** XMR lock tx hash — used to compute deposit-based restore_height for faster wallet scan. */
        readonly lockTxId?: string;
    };
}

/** Position info for a single job in the queue. */
export interface QueuePosition {
    readonly swapId: string;
    /** 1 = currently processing, 2+ = waiting. */
    readonly position: number;
    readonly total: number;
}

/** Callback types. */
export type SweepExecutor = (job: SweepJob) => Promise<void>;
export type QueueUpdateCallback = (positions: QueuePosition[]) => void;

const MAX_QUEUE_SIZE = 100;

export class SweepQueue {
    private readonly queue: SweepJob[] = [];
    /** Promise chain acting as an async mutex — ensures only one processNext runs at a time. */
    private processingChain: Promise<void> = Promise.resolve();
    private _isProcessing = false;
    private readonly executor: SweepExecutor;
    private readonly onUpdate: QueueUpdateCallback;

    public constructor(executor: SweepExecutor, onUpdate: QueueUpdateCallback) {
        this.executor = executor;
        this.onUpdate = onUpdate;
    }

    /** Enqueue a sweep job. Returns true if enqueued (or already queued), false if queue full. */
    public enqueue(job: SweepJob): boolean {
        if (this.queue.some((j) => j.swapId === job.swapId)) {
            console.log(`[SweepQueue] ${job.swapId} already queued — skipping`);
            return true; // already queued, considered success
        }
        if (this.queue.length >= MAX_QUEUE_SIZE) {
            console.error(`[SweepQueue] Queue full (${MAX_QUEUE_SIZE}) — rejecting ${job.swapId}`);
            return false;
        }
        this.queue.push(job);
        console.log(`[SweepQueue] Enqueued ${job.swapId} (queue length: ${this.queue.length})`);
        this.broadcastPositions();
        // Chain the next processing step onto the mutex — prevents concurrent processNext()
        this.processingChain = this.processingChain.then(() => this.processNext());
        return true;
    }

    /** Returns the 1-based position for a swapId, or null if not queued. */
    public getPosition(swapId: string): { position: number; total: number } | null {
        const idx = this.queue.findIndex((j) => j.swapId === swapId);
        if (idx === -1) return null;
        return { position: idx + 1, total: this.queue.length };
    }

    /** Returns all current positions. */
    public getPositions(): QueuePosition[] {
        return this.queue.map((j, i) => ({
            swapId: j.swapId,
            position: i + 1,
            total: this.queue.length,
        }));
    }

    /** Number of jobs in the queue (including the one currently processing). */
    public get length(): number {
        return this.queue.length;
    }

    /** Whether a sweep is currently being processed. */
    public get isProcessing(): boolean {
        return this._isProcessing;
    }

    private async processNext(): Promise<void> {
        if (this._isProcessing || this.queue.length === 0) return;

        this._isProcessing = true;
        const job = this.queue[0]!;

        console.log(`[SweepQueue] Processing ${job.swapId} (${this.queue.length} in queue)`);

        try {
            await this.executor(job);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[SweepQueue] Executor failed for ${job.swapId}: ${msg}`);
        }

        // Remove the completed job (always — even on failure)
        this.queue.shift();
        this._isProcessing = false;

        console.log(`[SweepQueue] Finished ${job.swapId} (${this.queue.length} remaining)`);
        this.broadcastPositions();
        // No recursive call needed — enqueue() already chains processNext() on the mutex.
    }

    private broadcastPositions(): void {
        try {
            this.onUpdate(this.getPositions());
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            console.error(`[SweepQueue] onUpdate callback failed: ${msg}`);
        }
    }
}
