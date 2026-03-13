/**
 * Unit tests for SweepQueue.
 *
 * No coordinator process needed — tests the queue logic in isolation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SweepQueue, type SweepJob, type QueuePosition } from '../src/sweep-queue.js';

function makeJob(swapId: string): SweepJob {
    return {
        swapId,
        sweepArgs: {
            spendKeyHex: 'aa'.repeat(32),
            viewKeyHex: 'bb'.repeat(32),
            lockAddress: '5' + 'A'.repeat(94),
            aliceAmountPiconero: 1000000000000n,
            aliceAddress: '4' + 'B'.repeat(94),
        },
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

describe('SweepQueue', () => {
    it('single job processes and completes', async () => {
        let executed = false;
        const updates: QueuePosition[][] = [];

        const queue = new SweepQueue(
            async (_job) => {
                executed = true;
            },
            (positions) => updates.push([...positions]),
        );

        queue.enqueue(makeJob('swap-1'));

        // Wait for async processing
        await sleep(50);

        assert.ok(executed, 'executor should have been called');
        assert.equal(queue.length, 0, 'queue should be empty after completion');

        // Should have at least 2 updates: enqueue (length 1) and dequeue (length 0)
        assert.ok(updates.length >= 2, `expected >= 2 updates, got ${updates.length}`);
        assert.equal(updates[0]!.length, 1, 'first update should show 1 item');
        assert.equal(updates[0]![0]!.position, 1);
        assert.equal(updates[updates.length - 1]!.length, 0, 'last update should be empty');
    });

    it('multiple jobs process in FIFO order', async () => {
        const order: string[] = [];

        const queue = new SweepQueue(
            async (job) => {
                order.push(job.swapId);
                await sleep(20);
            },
            () => {},
        );

        queue.enqueue(makeJob('A'));
        queue.enqueue(makeJob('B'));
        queue.enqueue(makeJob('C'));

        // Wait for all to complete
        await sleep(200);

        assert.deepEqual(order, ['A', 'B', 'C'], 'jobs should execute in FIFO order');
        assert.equal(queue.length, 0);
    });

    it('duplicate enqueue is no-op', async () => {
        let callCount = 0;

        const queue = new SweepQueue(
            async () => {
                callCount++;
                await sleep(50);
            },
            () => {},
        );

        queue.enqueue(makeJob('swap-1'));
        queue.enqueue(makeJob('swap-1')); // duplicate — should be ignored
        queue.enqueue(makeJob('swap-1')); // duplicate — should be ignored

        await sleep(150);

        assert.equal(callCount, 1, 'executor should only be called once');
    });

    it('position broadcasts on enqueue and completion', async () => {
        const updates: QueuePosition[][] = [];

        const queue = new SweepQueue(
            async () => {
                await sleep(30);
            },
            (positions) => updates.push(positions.map((p) => ({ ...p }))),
        );

        queue.enqueue(makeJob('X'));
        queue.enqueue(makeJob('Y'));
        queue.enqueue(makeJob('Z'));

        // After enqueue, Y and Z should show positions 2 and 3
        const lastEnqueue = updates[updates.length - 1]!;
        assert.equal(lastEnqueue.length, 3);
        assert.equal(lastEnqueue[0]!.swapId, 'X');
        assert.equal(lastEnqueue[0]!.position, 1);
        assert.equal(lastEnqueue[1]!.swapId, 'Y');
        assert.equal(lastEnqueue[1]!.position, 2);
        assert.equal(lastEnqueue[2]!.swapId, 'Z');
        assert.equal(lastEnqueue[2]!.position, 3);

        await sleep(200);

        // Final update should be empty
        const lastUpdate = updates[updates.length - 1]!;
        assert.equal(lastUpdate.length, 0);
    });

    it('positions decrement as jobs complete', async () => {
        const positionsForY: number[] = [];

        const queue = new SweepQueue(
            async () => {
                await sleep(30);
            },
            (positions) => {
                const yPos = positions.find((p) => p.swapId === 'Y');
                if (yPos) positionsForY.push(yPos.position);
            },
        );

        queue.enqueue(makeJob('X'));
        queue.enqueue(makeJob('Y'));

        await sleep(200);

        // Y should have been position 2, then position 1
        assert.ok(positionsForY.includes(2), 'Y should start at position 2');
        assert.ok(positionsForY.includes(1), 'Y should move to position 1');
    });

    it('failed executor does not block queue', async () => {
        const order: string[] = [];

        const queue = new SweepQueue(
            async (job) => {
                order.push(job.swapId);
                if (job.swapId === 'fail') {
                    throw new Error('Intentional test failure');
                }
                await sleep(10);
            },
            () => {},
        );

        queue.enqueue(makeJob('fail'));
        queue.enqueue(makeJob('ok-1'));
        queue.enqueue(makeJob('ok-2'));

        await sleep(200);

        assert.deepEqual(order, ['fail', 'ok-1', 'ok-2'], 'all jobs should execute despite failure');
        assert.equal(queue.length, 0, 'queue should be empty');
    });

    it('getPosition returns correct info', () => {
        const queue = new SweepQueue(
            async () => { await sleep(1000); },
            () => {},
        );

        queue.enqueue(makeJob('A'));
        queue.enqueue(makeJob('B'));
        queue.enqueue(makeJob('C'));

        assert.deepEqual(queue.getPosition('A'), { position: 1, total: 3 });
        assert.deepEqual(queue.getPosition('B'), { position: 2, total: 3 });
        assert.deepEqual(queue.getPosition('C'), { position: 3, total: 3 });
        assert.equal(queue.getPosition('D'), null);
    });

    it('getPositions returns all entries', () => {
        const queue = new SweepQueue(
            async () => { await sleep(1000); },
            () => {},
        );

        queue.enqueue(makeJob('X'));
        queue.enqueue(makeJob('Y'));

        const positions = queue.getPositions();
        assert.equal(positions.length, 2);
        assert.equal(positions[0]!.swapId, 'X');
        assert.equal(positions[0]!.position, 1);
        assert.equal(positions[0]!.total, 2);
        assert.equal(positions[1]!.swapId, 'Y');
        assert.equal(positions[1]!.position, 2);
        assert.equal(positions[1]!.total, 2);
    });
});
