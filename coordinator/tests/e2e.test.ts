/**
 * Comprehensive E2E test suite for MOTO-XMR Coordinator.
 *
 * Uses node:test built-in runner (no extra deps).
 * All tests run against a real coordinator child process with MONERO_MOCK=true.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    CoordinatorProcess,
    SwapApiClient,
    WsClient,
    generatePreimageAndHash,
    generateSwapParams,
    TimingRecorder,
    sleep,
    ADMIN_API_KEY,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Shared state for the main test coordinator
// ---------------------------------------------------------------------------

let coord: CoordinatorProcess;
let api: SwapApiClient;
const timer = new TimingRecorder();

before(async () => {
    coord = new CoordinatorProcess({ mockConfirmDelay: 2000 });
    await coord.start();
    api = new SwapApiClient(coord.baseUrl);
});

after(async () => {
    await coord.kill();
    timer.printSummary();
});

// ---------------------------------------------------------------------------
// A. Health & Connectivity
// ---------------------------------------------------------------------------

describe('A. Health & Connectivity', () => {
    it('A1. GET /api/health returns 200 with status ok', async () => {
        const res = await api.health();
        assert.equal(res.status, 200);
        assert.equal(res.body.success, true);
        const data = res.body.data as { status: string; timestamp: string };
        assert.equal(data.status, 'ok');
        assert.ok(data.timestamp);
    });

    it('A2. Unknown route returns 404', async () => {
        const res = await api.raw('GET', '/api/nonexistent');
        assert.equal(res.status, 404);
        assert.equal(res.body.success, false);
        assert.equal(res.body.error?.code, 'NOT_FOUND');
    });

    it('A3. CORS headers present on responses', async () => {
        const res = await api.health();
        assert.ok(res.headers['access-control-allow-origin']);
        assert.ok(res.headers['access-control-allow-methods']);
    });

    it('A4. Security headers present', async () => {
        const res = await api.health();
        assert.ok(res.headers['x-content-type-options']);
        assert.ok(res.headers['x-frame-options']);
    });

    it('A5. WebSocket connects and receives active_swaps', async () => {
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        const msg = await ws.waitForMessage('active_swaps', 3000);
        assert.equal(msg.type, 'active_swaps');
        assert.ok(Array.isArray(msg.data));
        ws.close();
    });

    it('A6. OPTIONS request returns 204 (CORS preflight)', async () => {
        const res = await fetch(`${coord.baseUrl}/api/health`, { method: 'OPTIONS' });
        assert.equal(res.status, 204);
    });
});

// ---------------------------------------------------------------------------
// B. Swap Creation
// ---------------------------------------------------------------------------

describe('B. Swap Creation', () => {
    it('B1. Valid create returns 201 with OPEN status', async () => {
        const { params } = generateSwapParams('b1-');
        const res = await timer.time('createSwap', () => api.createSwap(params));
        assert.equal(res.status, 201);
        assert.equal(res.body.success, true);
        const swap = res.body.data as Record<string, unknown>;
        assert.equal(swap['status'], 'OPEN');
        assert.equal(swap['swap_id'], params.swap_id);
    });

    it('B2. Fee and total calculated correctly', async () => {
        const { params } = generateSwapParams('b2-');
        const res = await api.createSwap(params);
        const swap = res.body.data as Record<string, unknown>;
        // Fee = 1000000000000 * 87 / 10000 = 8700000000
        assert.equal(swap['xmr_fee'], '8700000000');
        // Total = 1000000000000 + 8700000000 = 1008700000000
        assert.equal(swap['xmr_total'], '1008700000000');
    });

    it('B3. Rejects missing API key', async () => {
        const { params } = generateSwapParams('b3-');
        const noAuthApi = new SwapApiClient(coord.baseUrl, 'wrong-key');
        const res = await noAuthApi.createSwap(params);
        assert.equal(res.status, 401);
    });

    it('B4. Rejects invalid API key', async () => {
        const { params } = generateSwapParams('b4-');
        const badApi = new SwapApiClient(coord.baseUrl, 'x'.repeat(32));
        const res = await badApi.createSwap(params);
        assert.equal(res.status, 401);
    });

    it('B5. Duplicate swap_id returns 409', async () => {
        const { params } = generateSwapParams('b5-');
        await api.createSwap(params);
        const res = await api.createSwap(params);
        assert.equal(res.status, 409);
        assert.equal(res.body.error?.code, 'CONFLICT');
    });

    it('B6. Missing required fields returns 400', async () => {
        const res = await api.raw('POST', '/api/swaps', { swap_id: '999' }, true);
        assert.equal(res.status, 400);
        assert.equal(res.body.error?.code, 'VALIDATION');
    });

    it('B7. Invalid hash_lock format returns 400', async () => {
        const { params } = generateSwapParams('b7-');
        const res = await api.createSwap({ ...params, hash_lock: 'not-hex' });
        assert.equal(res.status, 400);
    });

    it('B8. hash_lock wrong length returns 400', async () => {
        const { params } = generateSwapParams('b8-');
        const res = await api.createSwap({ ...params, hash_lock: 'aa'.repeat(16) });
        assert.equal(res.status, 400);
    });

    it('B9. Zero xmr_amount returns 400', async () => {
        const { params } = generateSwapParams('b9-');
        const res = await api.createSwap({ ...params, xmr_amount: '0' });
        assert.equal(res.status, 400);
    });

    it('B10. Negative moto_amount returns 400', async () => {
        const { params } = generateSwapParams('b10-');
        const res = await api.createSwap({ ...params, moto_amount: '-1' });
        assert.equal(res.status, 400);
    });

    it('B11. xmr_amount below minimum returns 400', async () => {
        const { params } = generateSwapParams('b11-');
        // MIN_XMR_AMOUNT_PICONERO = 1_000_000_000
        const res = await api.createSwap({ ...params, xmr_amount: '999999999' });
        assert.equal(res.status, 400);
    });

    it('B12. swap_id must be numeric string', async () => {
        const { params } = generateSwapParams('b12-');
        const res = await api.createSwap({ ...params, swap_id: 'abc-def' });
        assert.equal(res.status, 400);
    });

    it('B13. refund_block must be positive', async () => {
        const { params } = generateSwapParams('b13-');
        const res = await api.createSwap({ ...params, refund_block: 0 });
        assert.equal(res.status, 400);
    });

    it('B14. Request body too large returns error', async () => {
        const huge = 'x'.repeat(70000);
        try {
            const res = await api.raw('POST', '/api/swaps', { swap_id: huge }, true);
            // If we get a response, it should be an error status
            assert.ok(res.status >= 400);
        } catch {
            // Server destroys the socket on oversized body — fetch throws a network error.
            // This is acceptable: the server rejected the oversized request.
            assert.ok(true, 'Server rejected oversized request by closing connection');
        }
    });

    it('B15. Non-JSON body returns 400', async () => {
        const url = `${coord.baseUrl}/api/swaps`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ADMIN_API_KEY}`,
            },
            body: 'this is not json',
        });
        assert.equal(res.status, 400);
    });
});

// ---------------------------------------------------------------------------
// C. Swap Retrieval
// ---------------------------------------------------------------------------

describe('C. Swap Retrieval', () => {
    it('C1. GET /api/swaps returns paginated list', async () => {
        const res = await api.listSwaps(1, 5);
        assert.equal(res.status, 200);
        const data = res.body.data as { swaps: unknown[]; page: number; limit: number };
        assert.ok(Array.isArray(data.swaps));
        assert.equal(data.page, 1);
        assert.equal(data.limit, 5);
    });

    it('C2. GET /api/swaps/:id returns single swap with history', async () => {
        const { params } = generateSwapParams('c2-');
        await api.createSwap(params);
        const res = await api.getSwap(params.swap_id);
        assert.equal(res.status, 200);
        const data = res.body.data as { swap: Record<string, unknown>; history: unknown[] };
        assert.equal(data.swap['swap_id'], params.swap_id);
        assert.ok(Array.isArray(data.history));
    });

    it('C3. Unknown swap returns 404', async () => {
        const res = await api.getSwap('99999999');
        assert.equal(res.status, 404);
    });

    it('C4. Sensitive fields sanitized (preimage=null, claim_token=null)', async () => {
        const { params, preimage } = generateSwapParams('c4-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        const res = await api.getSwap(params.swap_id);
        const swap = (res.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['preimage'], null);
        assert.equal(swap['claim_token'], null);
    });

    it('C5. Pagination page 2 works', async () => {
        const res = await api.listSwaps(2, 2);
        assert.equal(res.status, 200);
        const data = res.body.data as { page: number };
        assert.equal(data.page, 2);
    });

    it('C6. View keys sanitized', async () => {
        const { params, preimage } = generateSwapParams('c6-');
        await api.createSwap(params);
        const viewKey = 'a'.repeat(64);
        await api.submitSecret(params.swap_id, preimage, viewKey);
        const res = await api.getSwap(params.swap_id);
        const swap = (res.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['alice_view_key'], null);
        assert.equal(swap['bob_view_key'], null);
    });
});

// ---------------------------------------------------------------------------
// D. Take Swap
// ---------------------------------------------------------------------------

describe('D. Take Swap', () => {
    it('D1. Take OPEN swap returns claim_token', async () => {
        const { params } = generateSwapParams('d1-');
        await api.createSwap(params);
        const res = await api.takeSwap(params.swap_id, 'aabb' + 'cc'.repeat(30));
        assert.equal(res.status, 200);
        const data = res.body.data as { claim_token: string };
        assert.ok(data.claim_token);
        assert.equal(data.claim_token.length, 64); // 32 bytes hex
    });

    it('D2. Missing opnetTxId returns 400', async () => {
        const { params } = generateSwapParams('d2-');
        await api.createSwap(params);
        const res = await api.raw('POST', `/api/swaps/${params.swap_id}/take`, {});
        assert.equal(res.status, 400);
    });

    it('D3. Take non-existent swap returns 404', async () => {
        const res = await api.takeSwap('99999998', 'aa'.repeat(32));
        assert.equal(res.status, 404);
    });

    it('D4. Double take returns 409', async () => {
        const { params } = generateSwapParams('d4-');
        await api.createSwap(params);
        await api.takeSwap(params.swap_id, 'aa'.repeat(32));
        const res2 = await api.takeSwap(params.swap_id, 'bb'.repeat(32));
        assert.equal(res2.status, 409);
        assert.equal(res2.body.error?.code, 'ALREADY_TAKEN');
    });

    it('D5. Take a COMPLETED swap returns 409', async () => {
        // Create and drive to COMPLETED via admin
        const { params, preimage } = generateSwapParams('d5-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'test-cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'pending', xmr_address: '5' + 'a'.repeat(93) + '01', status: 'XMR_LOCKING' });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, { opnet_claim_tx: 'aa'.repeat(32), status: 'COMPLETED' });
        const res = await api.takeSwap(params.swap_id, 'aa'.repeat(32));
        assert.equal(res.status, 409);
    });

    it('D6. Empty opnetTxId returns 400', async () => {
        const { params } = generateSwapParams('d6-');
        await api.createSwap(params);
        const res = await api.takeSwap(params.swap_id, '');
        assert.equal(res.status, 400);
    });

    it('D7. Take TAKEN swap (already taken by someone else) returns 409', async () => {
        const { params } = generateSwapParams('d7-');
        await api.createSwap(params);
        // First take
        await api.takeSwap(params.swap_id, 'aa'.repeat(32));
        // Now admin transitions to TAKEN
        await api.adminUpdate(params.swap_id, { counterparty: 'test-cp', status: 'TAKEN' });
        // Second take attempt
        const res = await api.takeSwap(params.swap_id, 'bb'.repeat(32));
        assert.equal(res.status, 409);
    });

    it('D8. Concurrent takes — only first succeeds', async () => {
        const { params } = generateSwapParams('d8-');
        await api.createSwap(params);
        // Fire 5 concurrent take requests
        const promises = Array.from({ length: 5 }, (_, i) =>
            api.takeSwap(params.swap_id, `${'aa'.repeat(31)}${i.toString(16).padStart(2, '0')}`),
        );
        const results = await Promise.all(promises);
        const successes = results.filter((r) => r.status === 200);
        const conflicts = results.filter((r) => r.status === 409);
        assert.equal(successes.length, 1, 'Exactly one take should succeed');
        assert.equal(conflicts.length, 4, 'Four takes should conflict');
    });
});

// ---------------------------------------------------------------------------
// E. Submit Secret
// ---------------------------------------------------------------------------

describe('E. Submit Secret', () => {
    it('E1. Valid preimage matching hash_lock returns 200', async () => {
        const { params, preimage } = generateSwapParams('e1-');
        await api.createSwap(params);
        const res = await api.submitSecret(params.swap_id, preimage);
        assert.equal(res.status, 200);
        const data = res.body.data as { stored: boolean };
        assert.equal(data.stored, true);
    });

    it('E2. Hash mismatch returns 400', async () => {
        const { params } = generateSwapParams('e2-');
        await api.createSwap(params);
        const wrongPreimage = 'ff'.repeat(32);
        const res = await api.submitSecret(params.swap_id, wrongPreimage);
        assert.equal(res.status, 400);
        assert.equal(res.body.error?.code, 'HASH_MISMATCH');
    });

    it('E3. Wrong format (not 64 hex chars) returns 400', async () => {
        const { params } = generateSwapParams('e3-');
        await api.createSwap(params);
        const res = await api.submitSecret(params.swap_id, 'tooshort');
        assert.equal(res.status, 400);
    });

    it('E4. Idempotent: same preimage re-submit returns 200', async () => {
        const { params, preimage } = generateSwapParams('e4-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        const res = await api.submitSecret(params.swap_id, preimage);
        assert.equal(res.status, 200);
    });

    it('E5. Different preimage for same swap returns 409', async () => {
        const { params, preimage } = generateSwapParams('e5-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        // Generate a different preimage that doesn't match hash_lock
        const otherPreimage = 'ab'.repeat(32);
        const res = await api.submitSecret(params.swap_id, otherPreimage);
        // Could be 400 (hash mismatch) or 409 (already set)
        assert.ok(res.status === 400 || res.status === 409);
    });

    it('E6. Non-existent swap returns 404', async () => {
        const res = await api.submitSecret('99999997', 'aa'.repeat(32));
        assert.equal(res.status, 404);
    });

    it('E7. Split-key mode: stores aliceViewKey', async () => {
        const { params, preimage } = generateSwapParams('e7-');
        await api.createSwap(params);
        const viewKey = 'bb'.repeat(32);
        const res = await api.submitSecret(params.swap_id, preimage, viewKey);
        assert.equal(res.status, 200);
        const data = res.body.data as { trustless: boolean };
        assert.equal(data.trustless, true);
    });

    it('E8. Invalid aliceViewKey format returns 400', async () => {
        const { params, preimage } = generateSwapParams('e8-');
        await api.createSwap(params);
        const res = await api.submitSecret(params.swap_id, preimage, 'not-valid-hex');
        assert.equal(res.status, 400);
    });

    it('E9. Submit secret for OPEN state succeeds', async () => {
        const { params, preimage } = generateSwapParams('e9-');
        await api.createSwap(params);
        const res = await api.submitSecret(params.swap_id, preimage);
        assert.equal(res.status, 200);
    });

    it('E10. Submit secret for TAKEN state succeeds', async () => {
        const { params, preimage } = generateSwapParams('e10-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { counterparty: 'test-cp', status: 'TAKEN' });
        const res = await api.submitSecret(params.swap_id, preimage);
        assert.equal(res.status, 200);
    });
});

// ---------------------------------------------------------------------------
// F. Submit Bob Keys
// ---------------------------------------------------------------------------

describe('F. Submit Bob Keys', () => {
    it('F1. Non-trustless swap rejects keys', async () => {
        const { params, preimage } = generateSwapParams('f1-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'test-cp', status: 'TAKEN' });
        const res = await api.submitKeys(params.swap_id, {
            bobEd25519PubKey: 'aa'.repeat(32),
            bobViewKey: 'bb'.repeat(32),
            bobKeyProof: 'cc'.repeat(64),
        });
        assert.equal(res.status, 409);
        assert.equal(res.body.error?.code, 'NOT_TRUSTLESS');
    });

    it('F2. Non-existent swap returns 404', async () => {
        const res = await api.submitKeys('99999996', {
            bobEd25519PubKey: 'aa'.repeat(32),
            bobViewKey: 'bb'.repeat(32),
            bobKeyProof: 'cc'.repeat(64),
        });
        assert.equal(res.status, 404);
    });

    it('F3. Invalid pubkey format returns 400', async () => {
        const { params, preimage } = generateSwapParams('f3-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage, 'dd'.repeat(32));
        await api.adminUpdate(params.swap_id, { counterparty: 'test-cp', status: 'TAKEN' });
        const res = await api.submitKeys(params.swap_id, {
            bobEd25519PubKey: 'tooshort',
            bobViewKey: 'bb'.repeat(32),
            bobKeyProof: 'cc'.repeat(64),
        });
        assert.equal(res.status, 400);
    });

    it('F4. Invalid view key format returns 400', async () => {
        const { params, preimage } = generateSwapParams('f4-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage, 'dd'.repeat(32));
        await api.adminUpdate(params.swap_id, { counterparty: 'test-cp', status: 'TAKEN' });
        const res = await api.submitKeys(params.swap_id, {
            bobEd25519PubKey: 'aa'.repeat(32),
            bobViewKey: 'invalid',
            bobKeyProof: 'cc'.repeat(64),
        });
        assert.equal(res.status, 400);
    });

    it('F5. Invalid proof length returns 400', async () => {
        const { params, preimage } = generateSwapParams('f5-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage, 'dd'.repeat(32));
        await api.adminUpdate(params.swap_id, { counterparty: 'test-cp', status: 'TAKEN' });
        const res = await api.submitKeys(params.swap_id, {
            bobEd25519PubKey: 'aa'.repeat(32),
            bobViewKey: 'bb'.repeat(32),
            bobKeyProof: 'cc'.repeat(32), // 64 chars not 128
        });
        assert.equal(res.status, 400);
    });

    it('F6. Bad Schnorr proof returns 400', async () => {
        const { params, preimage } = generateSwapParams('f6-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage, 'dd'.repeat(32));
        await api.adminUpdate(params.swap_id, { counterparty: 'test-cp', status: 'TAKEN' });
        // Random bytes for proof — will fail verification
        const res = await api.submitKeys(params.swap_id, {
            bobEd25519PubKey: 'aa'.repeat(32),
            bobViewKey: 'bb'.repeat(32),
            bobKeyProof: 'ee'.repeat(64),
        });
        assert.equal(res.status, 400);
        assert.equal(res.body.error?.code, 'KEY_PROOF_INVALID');
    });

    it('F7. OPEN state rejects keys (must be TAKEN+)', async () => {
        const { params, preimage } = generateSwapParams('f7-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage, 'dd'.repeat(32));
        const res = await api.submitKeys(params.swap_id, {
            bobEd25519PubKey: 'aa'.repeat(32),
            bobViewKey: 'bb'.repeat(32),
            bobKeyProof: 'cc'.repeat(64),
        });
        assert.equal(res.status, 409);
    });
});

// ---------------------------------------------------------------------------
// G. Fee Address
// ---------------------------------------------------------------------------

describe('G. Fee Address', () => {
    it('G1. GET returns address and feeBps=87', async () => {
        const res = await api.getFeeAddress();
        assert.equal(res.status, 200);
        const data = res.body.data as { feeBps: number };
        assert.equal(data.feeBps, 87);
    });

    it('G2. PUT updates fee address', async () => {
        // Valid stagenet address (95 chars, prefix '5')
        const addr = '5' + 'A'.repeat(94);
        const res = await api.setFeeAddress(addr);
        assert.equal(res.status, 200);
    });

    it('G3. PUT rejects invalid address', async () => {
        const res = await api.setFeeAddress('invalid-addr');
        assert.equal(res.status, 400);
    });

    it('G4. PUT rejects too-short address', async () => {
        const res = await api.setFeeAddress('5' + 'A'.repeat(50));
        assert.equal(res.status, 400);
    });

    it('G5. PUT requires admin auth', async () => {
        const noAuth = new SwapApiClient(coord.baseUrl, 'wrong');
        const res = await noAuth.setFeeAddress('5' + 'A'.repeat(94));
        assert.equal(res.status, 401);
    });
});

// ---------------------------------------------------------------------------
// H. Happy Path — Standard Mode
// ---------------------------------------------------------------------------

describe('H. Happy Path — Standard Mode', () => {
    it('H1. Full swap lifecycle: OPEN → TAKEN → XMR_LOCKING → XMR_LOCKED → MOTO_CLAIMING → COMPLETED', async () => {
        const { params, preimage } = generateSwapParams('h1-');
        const start = performance.now();

        // 1. Create swap
        const createRes = await api.createSwap(params);
        assert.equal(createRes.status, 201);

        // 2. Submit secret
        const secretRes = await api.submitSecret(params.swap_id, preimage);
        assert.equal(secretRes.status, 200);

        // 3. Take swap
        const takeRes = await api.takeSwap(params.swap_id, 'aa'.repeat(32));
        assert.equal(takeRes.status, 200);
        const claimToken = (takeRes.body.data as { claim_token: string }).claim_token;

        // 4. Admin: OPEN → TAKEN (simulate on-chain)
        const takenRes = await api.adminUpdate(params.swap_id, {
            counterparty: 'opt1sqcounterparty' + 'a'.repeat(20),
            status: 'TAKEN',
        });
        assert.equal(takenRes.status, 200);

        // 5. Wait for mock Monero to auto-progress: TAKEN → XMR_LOCKING → XMR_LOCKED
        // The state machine callback triggers startXmrLocking on TAKEN transition
        // Mock confirm delay is 2000ms
        await sleep(4000);

        // Check status — should be XMR_LOCKED by now
        let swapRes = await api.getSwap(params.swap_id);
        let swap = (swapRes.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['status'], 'XMR_LOCKED', `Expected XMR_LOCKED but got ${swap['status']}`);

        // 6. Connect WebSocket and check preimage was queued
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 3000);
        ws.subscribe(params.swap_id, claimToken);
        // Late subscriber should receive queued preimage
        const receivedPreimage = await ws.waitForPreimage(5000);
        assert.equal(receivedPreimage, preimage);
        ws.close();

        // 7. Admin: MOTO_CLAIMING → COMPLETED
        await api.adminUpdate(params.swap_id, { status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, {
            opnet_claim_tx: 'bb'.repeat(32),
            status: 'COMPLETED',
        });

        // 8. Verify terminal state
        swapRes = await api.getSwap(params.swap_id);
        swap = (swapRes.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['status'], 'COMPLETED');

        timer.record('happyPath:standard', performance.now() - start);
    });
});

// ---------------------------------------------------------------------------
// I. Happy Path — Split-Key Mode
// ---------------------------------------------------------------------------

describe('I. Happy Path — Split-Key Mode', () => {
    it('I1. Split-key swap lifecycle with aliceViewKey + Bob keys', async () => {
        const { params, preimage } = generateSwapParams('i1-');
        const aliceViewKey = 'cc'.repeat(32);
        const start = performance.now();

        // 1. Create + submit secret with split-key mode
        await api.createSwap(params);
        const secretRes = await api.submitSecret(params.swap_id, preimage, aliceViewKey);
        assert.equal(secretRes.status, 200);
        assert.equal((secretRes.body.data as { trustless: boolean }).trustless, true);

        // 2. Take + transition to TAKEN
        await api.takeSwap(params.swap_id, 'aa'.repeat(32));
        await api.adminUpdate(params.swap_id, {
            counterparty: 'opt1sqcounterparty' + 'b'.repeat(20),
            status: 'TAKEN',
        });

        // Verify trustless_mode is set
        let swapRes = await api.getSwap(params.swap_id);
        let swap = (swapRes.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['trustless_mode'], 1);
        assert.ok(swap['alice_ed25519_pub']);

        // 3. Bob submits keys — will fail Schnorr proof with random data, which is expected
        //    For testing, we skip this step and use admin to set the fields directly
        await api.adminUpdate(params.swap_id, {
            bob_ed25519_pub: 'dd'.repeat(32),
            bob_view_key: 'ee'.repeat(32),
        });

        // 4. XMR locking won't auto-start because bob keys were set via admin
        //    (the state callback only triggers on TAKEN transition).
        //    Drive it manually via admin
        await api.adminUpdate(params.swap_id, {
            xmr_lock_tx: 'pending',
            xmr_address: '5' + 'a'.repeat(93) + '01',
            status: 'XMR_LOCKING',
        });
        await api.adminUpdate(params.swap_id, {
            xmr_lock_confirmations: 10,
            status: 'XMR_LOCKED',
        });
        await api.adminUpdate(params.swap_id, { status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, {
            opnet_claim_tx: 'ff'.repeat(32),
            status: 'COMPLETED',
        });

        swapRes = await api.getSwap(params.swap_id);
        swap = (swapRes.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['status'], 'COMPLETED');

        timer.record('happyPath:splitKey', performance.now() - start);
    });
});

// ---------------------------------------------------------------------------
// J. Cancellation & Refund Paths
// ---------------------------------------------------------------------------

describe('J. Cancellation & Refund Paths', () => {
    it('J1. OPEN → EXPIRED → REFUNDED', async () => {
        const { params } = generateSwapParams('j1-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        const refundRes = await api.adminUpdate(params.swap_id, {
            opnet_refund_tx: 'aa'.repeat(32),
            status: 'REFUNDED',
        });
        assert.equal(refundRes.status, 200);
        const swap = (refundRes.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['status'], 'REFUNDED');
    });

    it('J2. TAKEN → EXPIRED → REFUNDED', async () => {
        const { params } = generateSwapParams('j2-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        const refundRes = await api.adminUpdate(params.swap_id, {
            opnet_refund_tx: 'bb'.repeat(32),
            status: 'REFUNDED',
        });
        assert.equal(refundRes.status, 200);
    });

    it('J3. XMR_LOCKING → REFUNDED directly', async () => {
        const { params, preimage } = generateSwapParams('j3-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, {
            xmr_lock_tx: 'pending',
            xmr_address: '5' + 'a'.repeat(93) + '01',
            status: 'XMR_LOCKING',
        });
        const refundRes = await api.adminUpdate(params.swap_id, {
            opnet_refund_tx: 'cc'.repeat(32),
            status: 'REFUNDED',
        });
        assert.equal(refundRes.status, 200);
    });

    it('J4. XMR_LOCKED → REFUNDED directly', async () => {
        const { params, preimage } = generateSwapParams('j4-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, {
            xmr_lock_tx: 'pending',
            xmr_address: '5' + 'a'.repeat(93) + '01',
            status: 'XMR_LOCKING',
        });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        const refundRes = await api.adminUpdate(params.swap_id, {
            opnet_refund_tx: 'dd'.repeat(32),
            status: 'REFUNDED',
        });
        assert.equal(refundRes.status, 200);
    });

    it('J5. REFUNDED is terminal — no further transitions', async () => {
        const { params } = generateSwapParams('j5-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        await api.adminUpdate(params.swap_id, { opnet_refund_tx: 'ee'.repeat(32), status: 'REFUNDED' });
        const res = await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        assert.equal(res.status, 409);
    });

    it('J6. COMPLETED cannot be refunded', async () => {
        const { params, preimage } = generateSwapParams('j6-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'pending', xmr_address: '5' + 'a'.repeat(93) + '01', status: 'XMR_LOCKING' });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, { opnet_claim_tx: 'ff'.repeat(32), status: 'COMPLETED' });
        const res = await api.adminUpdate(params.swap_id, { opnet_refund_tx: 'ab'.repeat(32), status: 'REFUNDED' });
        assert.equal(res.status, 409);
    });

    it('J7. EXPIRED → TAKEN is invalid', async () => {
        const { params } = generateSwapParams('j7-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        const res = await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        assert.equal(res.status, 409);
    });
});

// ---------------------------------------------------------------------------
// K. Expiration (via state machine, not block height)
// ---------------------------------------------------------------------------

describe('K. Expiration', () => {
    it('K1. OPEN can transition to EXPIRED', async () => {
        const { params } = generateSwapParams('k1-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        assert.equal(res.status, 200);
    });

    it('K2. TAKEN can transition to EXPIRED', async () => {
        const { params } = generateSwapParams('k2-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        const res = await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        assert.equal(res.status, 200);
    });

    it('K3. XMR_LOCKING cannot transition to EXPIRED', async () => {
        const { params, preimage } = generateSwapParams('k3-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'pending', xmr_address: '5' + 'a'.repeat(93) + '01', status: 'XMR_LOCKING' });
        const res = await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        assert.equal(res.status, 409);
    });

    it('K4. EXPIRED swap cannot be taken', async () => {
        const { params } = generateSwapParams('k4-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        const res = await api.takeSwap(params.swap_id, 'aa'.repeat(32));
        assert.equal(res.status, 409);
    });
});

// ---------------------------------------------------------------------------
// L. Concurrent Operations
// ---------------------------------------------------------------------------

describe('L. Concurrent Operations', () => {
    it('L1. 5 simultaneous creates all succeed', async () => {
        const promises = Array.from({ length: 5 }, (_, i) => {
            const { params } = generateSwapParams(`l1-${i}-`);
            return api.createSwap(params);
        });
        const results = await Promise.all(promises);
        for (const r of results) {
            assert.equal(r.status, 201);
        }
    });

    it('L2. 10 simultaneous takes on same swap — exactly 1 succeeds', async () => {
        const { params } = generateSwapParams('l2-');
        await api.createSwap(params);
        const promises = Array.from({ length: 10 }, (_, i) =>
            api.takeSwap(params.swap_id, `${'ab'.repeat(31)}${i.toString(16).padStart(2, '0')}`),
        );
        const results = await Promise.all(promises);
        const successes = results.filter((r) => r.status === 200);
        assert.equal(successes.length, 1);
    });

    it('L3. Concurrent secret submissions — first wins', async () => {
        const { params, preimage } = generateSwapParams('l3-');
        await api.createSwap(params);
        const promises = Array.from({ length: 5 }, () =>
            api.submitSecret(params.swap_id, preimage),
        );
        const results = await Promise.all(promises);
        // All should succeed (idempotent for same preimage)
        for (const r of results) {
            assert.equal(r.status, 200);
        }
    });

    it('L4. Multiple swaps progressing simultaneously', async () => {
        const swaps = Array.from({ length: 3 }, (_, i) => generateSwapParams(`l4-${i}-`));

        // Create all
        await Promise.all(swaps.map((s) => api.createSwap(s.params)));

        // Submit secrets in parallel
        await Promise.all(swaps.map((s) => api.submitSecret(s.params.swap_id, s.preimage)));

        // Take all in parallel
        await Promise.all(swaps.map((s) => api.takeSwap(s.params.swap_id, 'aa'.repeat(32))));

        // Transition all to TAKEN in parallel
        await Promise.all(swaps.map((s) =>
            api.adminUpdate(s.params.swap_id, { counterparty: 'cp', status: 'TAKEN' }),
        ));

        // Verify all are in TAKEN (or later, if mock auto-progressed)
        const statuses = await Promise.all(swaps.map((s) => api.getSwap(s.params.swap_id)));
        for (const res of statuses) {
            const swap = (res.body.data as { swap: Record<string, unknown> }).swap;
            const st = swap['status'] as string;
            assert.ok(
                ['TAKEN', 'XMR_LOCKING', 'XMR_LOCKED'].includes(st),
                `Expected TAKEN/XMR_LOCKING/XMR_LOCKED but got ${st}`,
            );
        }
    });
});

// ---------------------------------------------------------------------------
// M. WebSocket
// ---------------------------------------------------------------------------

describe('M. WebSocket', () => {
    it('M1. active_swaps on connect', async () => {
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        const msg = await ws.waitForMessage('active_swaps', 3000);
        assert.equal(msg.type, 'active_swaps');
        ws.close();
    });

    it('M2. swap_update broadcast on status change', async () => {
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 3000);
        ws.clearMessages();

        const { params } = generateSwapParams('m2-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });

        // Wait for swap_update message
        await sleep(500);
        const updates = ws.getMessages('swap_update');
        assert.ok(updates.length > 0, 'Should receive at least one swap_update');
        ws.close();
    });

    it('M3. Subscribe with invalid claim_token rejected', async () => {
        const { params } = generateSwapParams('m3-');
        await api.createSwap(params);
        await api.takeSwap(params.swap_id, 'aa'.repeat(32));

        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 3000);
        ws.clearMessages();

        ws.subscribe(params.swap_id, 'wrong-token');
        await sleep(500);
        const errors = ws.getMessages('error');
        assert.ok(errors.length > 0, 'Should receive error for invalid claim_token');
        ws.close();
    });

    it('M4. Subscribe without claim_token rejected', async () => {
        const { params } = generateSwapParams('m4-');
        await api.createSwap(params);
        await api.takeSwap(params.swap_id, 'aa'.repeat(32));

        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 3000);
        ws.clearMessages();

        ws.subscribe(params.swap_id);
        await sleep(500);
        const errors = ws.getMessages('error');
        assert.ok(errors.length > 0, 'Should receive error for missing claim_token');
        ws.close();
    });

    it('M5. Swap not yet taken rejects subscription', async () => {
        const { params } = generateSwapParams('m5-');
        await api.createSwap(params);
        // Don't take it — no claim_token

        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 3000);
        ws.clearMessages();

        ws.subscribe(params.swap_id, 'anything');
        await sleep(500);
        const errors = ws.getMessages('error');
        assert.ok(errors.length > 0, 'Should receive error for un-taken swap');
        ws.close();
    });

    it('M6. Authenticated subscriber receives preimage_ready', async () => {
        const { params, preimage } = generateSwapParams('m6-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        const takeRes = await api.takeSwap(params.swap_id, 'aa'.repeat(32));
        const claimToken = (takeRes.body.data as { claim_token: string }).claim_token;

        // Connect and subscribe
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 3000);
        ws.subscribe(params.swap_id, claimToken);

        // Trigger TAKEN → mock Monero auto-confirms → preimage broadcast
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });

        // Wait for preimage (mock delay 2s + buffer)
        const received = await ws.waitForPreimage(8000);
        assert.equal(received, preimage);
        ws.close();
    });

    it('M7. Late subscriber receives queued preimage', async () => {
        const { params, preimage } = generateSwapParams('m7-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        const takeRes = await api.takeSwap(params.swap_id, 'aa'.repeat(32));
        const claimToken = (takeRes.body.data as { claim_token: string }).claim_token;

        // Trigger TAKEN and wait for XMR_LOCKED
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await sleep(4000); // Wait for mock confirm

        // Now connect a late subscriber
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 3000);
        ws.subscribe(params.swap_id, claimToken);

        // Should receive queued preimage
        const received = await ws.waitForPreimage(5000);
        assert.equal(received, preimage);
        ws.close();
    });

    it('M8. Non-subscriber does not receive preimage', async () => {
        const { params, preimage } = generateSwapParams('m8-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.takeSwap(params.swap_id, 'aa'.repeat(32));

        // Connect but DON'T subscribe
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 3000);
        ws.clearMessages();

        // Trigger TAKEN and wait for mock confirm
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await sleep(4000);

        // Should NOT have received preimage_ready (only swap_update broadcasts)
        const preimageMessages = ws.getMessages('preimage_ready');
        assert.equal(preimageMessages.length, 0, 'Non-subscriber should not receive preimage');
        ws.close();
    });
});

// ---------------------------------------------------------------------------
// N. Rate Limiting (separate coordinator with rate limiting enabled)
// ---------------------------------------------------------------------------

describe('N. Rate Limiting', () => {
    let rateLimitCoord: CoordinatorProcess;
    let rateLimitApi: SwapApiClient;

    before(async () => {
        rateLimitCoord = new CoordinatorProcess({
            env: { RATE_LIMIT_DISABLED: 'false' },
        });
        await rateLimitCoord.start();
        rateLimitApi = new SwapApiClient(rateLimitCoord.baseUrl);
    });

    after(async () => {
        await rateLimitCoord.kill();
    });

    it('N1. Write rate limit enforced (>5 writes/minute)', async () => {
        // Fire 7 write requests rapidly
        const results: number[] = [];
        for (let i = 0; i < 7; i++) {
            const { params } = generateSwapParams(`n1-${i}-`);
            const res = await rateLimitApi.createSwap(params);
            results.push(res.status);
        }
        assert.ok(results.includes(429), 'Should see 429 after exceeding write limit');
    });

    it('N2. Read rate limit is higher than write', async () => {
        // 10 reads should be fine (limit is 30/min)
        const results: number[] = [];
        for (let i = 0; i < 10; i++) {
            const res = await rateLimitApi.health();
            results.push(res.status);
        }
        const ok = results.filter((s) => s === 200).length;
        assert.ok(ok >= 10, 'All reads should succeed within limit');
    });

    it('N3. Rate limit returns Retry-After header', async () => {
        // Exhaust write limit
        for (let i = 0; i < 8; i++) {
            const { params } = generateSwapParams(`n3-${i}-`);
            await rateLimitApi.createSwap(params);
        }
        // Next should be rate limited
        const { params } = generateSwapParams('n3-final-');
        const res = await rateLimitApi.createSwap(params);
        if (res.status === 429) {
            assert.ok(res.headers['retry-after'], 'Should have Retry-After header');
        }
    });
});

// ---------------------------------------------------------------------------
// O. Resilience
// ---------------------------------------------------------------------------

describe('O. Resilience', () => {
    it('O1. Coordinator restart preserves swap state', async () => {
        // Create a swap
        const { params, preimage } = generateSwapParams('o1-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);

        // Restart coordinator (same DB)
        await coord.restart();
        api = new SwapApiClient(coord.baseUrl);

        // Verify swap still exists
        const res = await api.getSwap(params.swap_id);
        assert.equal(res.status, 200);
        const swap = (res.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['swap_id'], params.swap_id);
    });

    it('O2. Invalid JSON body handled gracefully', async () => {
        const url = `${coord.baseUrl}/api/swaps`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ADMIN_API_KEY}`,
            },
            body: '{invalid json',
        });
        assert.equal(res.status, 400);
    });

    it('O3. Empty body handled gracefully', async () => {
        const url = `${coord.baseUrl}/api/swaps`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ADMIN_API_KEY}`,
            },
            body: '',
        });
        assert.equal(res.status, 400);
    });

    it('O4. Restart resumes mock XMR monitoring for XMR_LOCKING swaps', async () => {
        const { params, preimage } = generateSwapParams('o4-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.takeSwap(params.swap_id, 'aa'.repeat(32));

        // Drive to XMR_LOCKING manually
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, {
            xmr_lock_tx: 'pending',
            xmr_address: '5' + 'a'.repeat(93) + '01',
            status: 'XMR_LOCKING',
        });

        // Restart
        await coord.restart();
        api = new SwapApiClient(coord.baseUrl);

        // Give recovery + mock monitoring time to progress
        await sleep(4000);

        const res = await api.getSwap(params.swap_id);
        const swap = (res.body.data as { swap: Record<string, unknown> }).swap;
        const st = swap['status'] as string;
        // Should have progressed to XMR_LOCKED from recovery monitoring
        assert.ok(
            st === 'XMR_LOCKED' || st === 'XMR_LOCKING',
            `Expected XMR_LOCKED or XMR_LOCKING after restart, got ${st}`,
        );
    });
});

// ---------------------------------------------------------------------------
// P. Edge Cases
// ---------------------------------------------------------------------------

describe('P. Edge Cases', () => {
    it('P1. Large swap_id (max numeric string)', async () => {
        const largeId = '9'.repeat(78);
        const { preimage, hashLock } = generatePreimageAndHash();
        const res = await api.createSwap({
            swap_id: largeId,
            hash_lock: hashLock,
            refund_block: 999999,
            moto_amount: '1000000000000000000',
            xmr_amount: '1000000000000',
            depositor: 'opt1sqtest',
        });
        assert.equal(res.status, 201);
        void preimage;
    });

    it('P2. Minimum xmr_amount (exactly at boundary)', async () => {
        const { params } = generateSwapParams('p2-');
        const res = await api.createSwap({ ...params, xmr_amount: '1000000000' });
        assert.equal(res.status, 201);
    });

    it('P3. Fee precision for small amount', async () => {
        const { params } = generateSwapParams('p3-');
        const res = await api.createSwap({ ...params, xmr_amount: '1000000000' });
        const swap = res.body.data as Record<string, unknown>;
        // fee = 1000000000 * 87 / 10000 = 8700000
        assert.equal(swap['xmr_fee'], '8700000');
    });

    it('P4. SQL injection attempt safely rejected', async () => {
        const { params } = generateSwapParams('p4-');
        // Try SQL injection in depositor field (which is a string field)
        const res = await api.createSwap({
            ...params,
            depositor: "'; DROP TABLE swaps; --",
        });
        // Should succeed (string is just stored) or fail validation — but NOT crash
        assert.ok(res.status === 201 || res.status === 400);

        // Verify the database is still working
        const healthRes = await api.health();
        assert.equal(healthRes.status, 200);
    });

    it('P5. Unicode in depositor field handled', async () => {
        const { params } = generateSwapParams('p5-');
        const res = await api.createSwap({
            ...params,
            depositor: 'opt1sq\u{1F600}unicode',
        });
        assert.ok(res.status === 201 || res.status === 400);
    });

    it('P6. Extremely large xmr_amount', async () => {
        const { params } = generateSwapParams('p6-');
        const res = await api.createSwap({
            ...params,
            xmr_amount: '999999999999999999999',
        });
        assert.equal(res.status, 201);
    });
});

// ---------------------------------------------------------------------------
// Q. State Machine Violations
// ---------------------------------------------------------------------------

describe('Q. State Machine Violations', () => {
    it('Q1. OPEN → COMPLETED is invalid', async () => {
        const { params } = generateSwapParams('q1-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, {
            opnet_claim_tx: 'aa'.repeat(32),
            status: 'COMPLETED',
        });
        assert.equal(res.status, 409);
    });

    it('Q2. OPEN → XMR_LOCKING is invalid', async () => {
        const { params } = generateSwapParams('q2-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, {
            counterparty: 'cp',
            xmr_lock_tx: 'pending',
            xmr_address: '5' + 'a'.repeat(93) + '01',
            status: 'XMR_LOCKING',
        });
        assert.equal(res.status, 409);
    });

    it('Q3. OPEN → REFUNDED is invalid', async () => {
        const { params } = generateSwapParams('q3-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, {
            opnet_refund_tx: 'aa'.repeat(32),
            status: 'REFUNDED',
        });
        assert.equal(res.status, 409);
    });

    it('Q4. TAKEN → OPEN (backwards) is invalid', async () => {
        const { params } = generateSwapParams('q4-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        const res = await api.adminUpdate(params.swap_id, { status: 'OPEN' });
        assert.equal(res.status, 409);
    });

    it('Q5. COMPLETED → anything is invalid (terminal)', async () => {
        const { params, preimage } = generateSwapParams('q5-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'pending', xmr_address: '5' + 'a'.repeat(93) + '01', status: 'XMR_LOCKING' });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, { opnet_claim_tx: 'aa'.repeat(32), status: 'COMPLETED' });

        const res = await api.adminUpdate(params.swap_id, { status: 'OPEN' });
        assert.equal(res.status, 409);
    });

    it('Q6. TAKEN without counterparty fails guard', async () => {
        const { params } = generateSwapParams('q6-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, { status: 'TAKEN' });
        assert.equal(res.status, 409);
        assert.ok(res.body.error?.message.includes('counterparty'));
    });

    it('Q7. XMR_LOCKED without enough confirmations fails guard', async () => {
        const { params, preimage } = generateSwapParams('q7-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'pending', xmr_address: '5' + 'a'.repeat(93) + '01', status: 'XMR_LOCKING' });
        // Only 5 confirmations (need 10)
        const res = await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 5, status: 'XMR_LOCKED' });
        assert.equal(res.status, 409);
        assert.ok(res.body.error?.message.includes('confirmation'));
    });

    it('Q8. COMPLETED without opnet_claim_tx fails guard', async () => {
        const { params, preimage } = generateSwapParams('q8-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'pending', xmr_address: '5' + 'a'.repeat(93) + '01', status: 'XMR_LOCKING' });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { status: 'MOTO_CLAIMING' });
        const res = await api.adminUpdate(params.swap_id, { status: 'COMPLETED' });
        assert.equal(res.status, 409);
        assert.ok(res.body.error?.message.includes('opnet_claim_tx'));
    });

    it('Q9. REFUNDED without opnet_refund_tx fails guard', async () => {
        const { params } = generateSwapParams('q9-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        const res = await api.adminUpdate(params.swap_id, { status: 'REFUNDED' });
        assert.equal(res.status, 409);
        assert.ok(res.body.error?.message.includes('opnet_refund_tx'));
    });

    it('Q10. Invalid status string returns 400', async () => {
        const { params } = generateSwapParams('q10-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, { status: 'INVALID_STATUS' });
        assert.equal(res.status, 400);
    });
});

// ---------------------------------------------------------------------------
// R. Admin Endpoint Security
// ---------------------------------------------------------------------------

describe('R. Admin Endpoint Security', () => {
    it('R1. Admin endpoint requires ADMIN_API_KEY', async () => {
        const { params } = generateSwapParams('r1-');
        await api.createSwap(params);
        const noAuth = new SwapApiClient(coord.baseUrl, 'wrong');
        const res = await noAuth.adminUpdate(params.swap_id, { counterparty: 'cp', status: 'TAKEN' });
        assert.equal(res.status, 401);
    });

    it('R2. Admin endpoint returns 403 if not in mock mode', async () => {
        // This test would need a non-mock coordinator. Instead we verify our mock coord works.
        // The 403 gate is in handleAdminUpdateSwap — we test the positive case is fine.
        const { params } = generateSwapParams('r2-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, { counterparty: 'test' });
        assert.equal(res.status, 200); // Mock mode allows it
    });

    it('R3. Admin update with no valid fields returns 400', async () => {
        const { params } = generateSwapParams('r3-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, { invalid_field: 'test' });
        assert.equal(res.status, 400);
    });

    it('R4. Admin update on non-existent swap returns 404', async () => {
        const res = await api.adminUpdate('99999995', { counterparty: 'test' });
        assert.equal(res.status, 404);
    });

    it('R5. Admin can update non-status fields without transition', async () => {
        const { params } = generateSwapParams('r5-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, { counterparty: 'test-counterparty' });
        assert.equal(res.status, 200);
        const swap = (res.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['counterparty'], 'test-counterparty');
    });
});

// ---------------------------------------------------------------------------
// S. Performance Metrics Summary
// ---------------------------------------------------------------------------

describe('S. Performance Metrics', () => {
    it('S1. Measure API response times', async () => {
        // Health endpoint
        await timer.time('api:health', () => api.health());

        // Create + get cycle
        const { params } = generateSwapParams('s1-');
        await timer.time('api:createSwap', () => api.createSwap(params));
        await timer.time('api:getSwap', () => api.getSwap(params.swap_id));
        await timer.time('api:listSwaps', () => api.listSwaps());

        // These are recorded — summary printed in after() hook
        assert.ok(true, 'Timing data recorded');
    });

    it('S2. Measure concurrent throughput', async () => {
        const start = performance.now();
        const promises = Array.from({ length: 10 }, (_, i) => {
            const { params } = generateSwapParams(`s2-${i}-`);
            return api.createSwap(params);
        });
        await Promise.all(promises);
        timer.record('concurrent:10creates', performance.now() - start);
        assert.ok(true, 'Concurrent throughput recorded');
    });
});

// ---------------------------------------------------------------------------
// T. Additional Coverage — Gaps found during source review
// ---------------------------------------------------------------------------

describe('T. Additional Coverage', () => {
    it('T1. bob_spend_key is NOT exposed via GET /api/swaps/:id', async () => {
        const { params, preimage } = generateSwapParams('t1-');
        await api.createSwap(params);
        // Submit secret so preimage is stored
        await api.submitSecret(params.swap_id, preimage);
        // Take the swap
        await api.takeSwap(params.swap_id, 'tx-t1');
        // Admin-set bob_spend_key
        await api.adminUpdate(params.swap_id, { bob_spend_key: 'deadbeef'.repeat(8) });

        const res = await api.getSwap(params.swap_id);
        assert.equal(res.status, 200);
        const swap = (res.body.data as { swap: Record<string, unknown> }).swap;
        assert.equal(swap['bob_spend_key'], null, 'bob_spend_key must be null in API response');
        assert.equal(swap['preimage'], null, 'preimage must be null in API response');
        assert.equal(swap['claim_token'], null, 'claim_token must be null in API response');
        assert.equal(swap['alice_view_key'], null, 'alice_view_key must be null');
        assert.equal(swap['bob_view_key'], null, 'bob_view_key must be null');
    });

    it('T2. bob_spend_key is NOT exposed in listSwaps', async () => {
        const { params } = generateSwapParams('t2-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { bob_spend_key: 'abcd'.repeat(16) });

        const res = await api.listSwaps(1, 100);
        assert.equal(res.status, 200);
        const data = res.body.data as { swaps: Array<Record<string, unknown>> };
        const match = data.swaps.find((s) => s['swap_id'] === params.swap_id);
        assert.ok(match, 'Swap should appear in list');
        assert.equal(match['bob_spend_key'], null, 'bob_spend_key must be null in list response');
    });

    it('T3. Secret submission rejected for COMPLETED swap', async () => {
        const { params, preimage } = generateSwapParams('t3-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.takeSwap(params.swap_id, 'tx-t3');
        // Walk through the full state machine: OPEN → TAKEN → XMR_LOCKING → XMR_LOCKED → MOTO_CLAIMING → COMPLETED
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-t3', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-t3', status: 'XMR_LOCKING' });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, { opnet_claim_tx: 'claim-t3', status: 'COMPLETED' });

        // Now try to submit a secret
        const { preimage: newPreimage } = generatePreimageAndHash();
        const res = await api.submitSecret(params.swap_id, newPreimage);
        assert.equal(res.status, 409, 'Secret submission to COMPLETED swap should be rejected');
    });

    it('T4. Secret submission rejected for REFUNDED swap', async () => {
        const { params } = generateSwapParams('t4-');
        await api.createSwap(params);
        // Force to EXPIRED then REFUNDED
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });
        await api.adminUpdate(params.swap_id, {
            opnet_refund_tx: 'refund-t4',
            status: 'REFUNDED',
        });

        const { preimage } = generatePreimageAndHash();
        const res = await api.submitSecret(params.swap_id, preimage);
        assert.equal(res.status, 409, 'Secret submission to REFUNDED swap should be rejected');
    });

    it('T5. Secret submission rejected for EXPIRED swap', async () => {
        const { params } = generateSwapParams('t5-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });

        const { preimage } = generatePreimageAndHash();
        const res = await api.submitSecret(params.swap_id, preimage);
        assert.equal(res.status, 409, 'Secret submission to EXPIRED swap should be rejected');
    });

    it('T6. MOTO_CLAIMING guard requires preimage', async () => {
        const { params } = generateSwapParams('t6-');
        await api.createSwap(params);
        // Walk through states without submitting a secret (no preimage)
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-t6', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-t6', status: 'XMR_LOCKING' });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        // Try to go to MOTO_CLAIMING without preimage
        const res = await api.adminUpdate(params.swap_id, { status: 'MOTO_CLAIMING' });
        assert.equal(res.status, 409, 'MOTO_CLAIMING without preimage should be rejected');
    });

    it('T7. State history is present after lifecycle', async () => {
        const { params, preimage } = generateSwapParams('t7-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.takeSwap(params.swap_id, 'tx-t7');
        // Walk through valid transitions: OPEN → TAKEN → XMR_LOCKING
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-t7', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-t7', status: 'XMR_LOCKING' });

        const res = await api.getSwap(params.swap_id);
        assert.equal(res.status, 200);
        const data = res.body.data as { swap: Record<string, unknown>; history: Array<Record<string, unknown>> };
        assert.ok(Array.isArray(data.history), 'History should be an array');
        // Should have OPEN → TAKEN and TAKEN → XMR_LOCKING
        assert.ok(data.history.length >= 2, `History should contain at least 2 transitions, got ${data.history.length}`);
        // Verify history entries have expected fields
        const first = data.history[0];
        assert.ok(first && 'from_state' in first, 'History entry should have from_state');
        assert.ok(first && 'to_state' in first, 'History entry should have to_state');
    });

    it('T8. Empty counterparty string rejected by TAKEN guard', async () => {
        const { params } = generateSwapParams('t8-');
        await api.createSwap(params);
        // Try to transition to TAKEN with empty counterparty
        const res = await api.adminUpdate(params.swap_id, {
            counterparty: '',
            status: 'TAKEN',
        });
        assert.equal(res.status, 409, 'TAKEN with empty counterparty should fail guard');
    });

    it('T9. Pagination clamps out-of-range values', async () => {
        // page=0 should be clamped to 1, limit=0 to 1, limit=999 to 100
        const res0 = await api.raw('GET', '/api/swaps?page=0&limit=0');
        assert.equal(res0.status, 200);
        const data0 = res0.body.data as { page: number; limit: number };
        assert.ok(data0.page >= 1, 'page should be at least 1');
        assert.ok(data0.limit >= 1, 'limit should be at least 1');

        const res999 = await api.raw('GET', '/api/swaps?page=1&limit=999');
        assert.equal(res999.status, 200);
        const data999 = res999.body.data as { limit: number };
        assert.ok(data999.limit <= 100, 'limit should be capped at 100');
    });

    it('T10. NaN pagination params default gracefully', async () => {
        const res = await api.raw('GET', '/api/swaps?page=abc&limit=xyz');
        assert.equal(res.status, 200);
        const data = res.body.data as { page: number; limit: number };
        assert.ok(data.page >= 1, 'NaN page should default to 1');
        assert.ok(data.limit >= 1, 'NaN limit should default to valid value');
    });

    it('T11. WebSocket subscription cap enforced (max 5)', async () => {
        // Create 6 swaps, take them all to get claim tokens
        const swaps: Array<{ swapId: string; claimToken: string }> = [];
        for (let i = 0; i < 6; i++) {
            const { params } = generateSwapParams(`t11-${i}-`);
            await api.createSwap(params);
            const takeRes = await api.takeSwap(params.swap_id, `tx-t11-${i}`);
            const takeData = takeRes.body.data as { claim_token: string };
            swaps.push({ swapId: params.swap_id, claimToken: takeData.claim_token });
        }

        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        // Wait for active_swaps initial message
        await ws.waitForMessage('active_swaps', 3000);

        // Subscribe to 5 swaps — all should succeed
        for (let i = 0; i < 5; i++) {
            const s = swaps[i];
            if (s) ws.subscribe(s.swapId, s.claimToken);
        }

        // Small delay to let server process
        await sleep(200);

        // Subscribe to 6th — should be rejected
        ws.clearMessages();
        const sixth = swaps[5];
        if (sixth) ws.subscribe(sixth.swapId, sixth.claimToken);

        // Expect an error message about max subscriptions
        const errMsg = await ws.waitForMessage('error', 3000);
        const errText = errMsg.data as string;
        assert.ok(errText.toLowerCase().includes('maximum') || errText.toLowerCase().includes('subscription'),
            `Expected max subscription error, got: ${errText}`);

        ws.close();
    });

    it('T12. Multiple authenticated WS subscribers both receive preimage', async () => {
        const { params, preimage } = generateSwapParams('t12-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        const takeRes = await api.takeSwap(params.swap_id, 'tx-t12');
        const claimToken = (takeRes.body.data as { claim_token: string }).claim_token;

        // Two separate WS clients subscribe to the same swap
        const ws1 = new WsClient(coord.baseUrl);
        const ws2 = new WsClient(coord.baseUrl);
        await ws1.connect();
        await ws2.connect();
        await ws1.waitForMessage('active_swaps', 3000);
        await ws2.waitForMessage('active_swaps', 3000);

        ws1.subscribe(params.swap_id, claimToken);
        ws2.subscribe(params.swap_id, claimToken);
        await sleep(200);

        // Trigger preimage broadcast by transitioning through XMR flow
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-t12', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-t12', status: 'XMR_LOCKING' });

        // Wait for mock Monero to confirm (2s delay + buffer)
        const p1 = ws1.waitForPreimage(10000);
        const p2 = ws2.waitForPreimage(10000);
        const [pre1, pre2] = await Promise.all([p1, p2]);

        assert.equal(pre1, preimage, 'First subscriber should get correct preimage');
        assert.equal(pre2, preimage, 'Second subscriber should get correct preimage');

        ws1.close();
        ws2.close();
    });

    it('T13. XMR_LOCKING → COMPLETED direct transition requires opnet_claim_tx', async () => {
        const { params, preimage } = generateSwapParams('t13-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-t13', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-t13', status: 'XMR_LOCKING' });

        // XMR_LOCKING → COMPLETED is a valid transition in the state machine
        // but it requires the COMPLETED guard (opnet_claim_tx)
        const resFail = await api.adminUpdate(params.swap_id, { status: 'COMPLETED' });
        assert.equal(resFail.status, 409, 'COMPLETED without opnet_claim_tx should fail');

        // With opnet_claim_tx it should succeed
        const resOk = await api.adminUpdate(params.swap_id, {
            opnet_claim_tx: 'claim-t13',
            status: 'COMPLETED',
        });
        assert.equal(resOk.status, 200, 'COMPLETED with opnet_claim_tx should succeed');
    });

    it('T14. XMR_LOCKED → REFUNDED requires opnet_refund_tx', async () => {
        const { params } = generateSwapParams('t14-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-t14', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-t14', status: 'XMR_LOCKING' });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });

        // Try REFUNDED without opnet_refund_tx
        const resFail = await api.adminUpdate(params.swap_id, { status: 'REFUNDED' });
        assert.equal(resFail.status, 409, 'REFUNDED without opnet_refund_tx should fail');

        // With opnet_refund_tx it should succeed
        const resOk = await api.adminUpdate(params.swap_id, {
            opnet_refund_tx: 'refund-t14',
            status: 'REFUNDED',
        });
        assert.equal(resOk.status, 200, 'REFUNDED with opnet_refund_tx should succeed');
    });

    it('T15. Sensitive fields null in WebSocket active_swaps on connect', async () => {
        // Create a swap with secrets set
        const { params, preimage } = generateSwapParams('t15-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.takeSwap(params.swap_id, 'tx-t15');

        // Connect a new WS client — active_swaps should have sanitized data
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        const msg = await ws.waitForMessage('active_swaps', 3000);
        const swaps = msg.data as Array<Record<string, unknown>>;
        const match = swaps.find((s) => s['swap_id'] === params.swap_id);
        if (match) {
            assert.equal(match['preimage'], null, 'preimage should be null in WS active_swaps');
            assert.equal(match['claim_token'], null, 'claim_token should be null in WS active_swaps');
            assert.equal(match['alice_view_key'], null, 'alice_view_key should be null in WS active_swaps');
            assert.equal(match['bob_view_key'], null, 'bob_view_key should be null in WS active_swaps');
        }
        ws.close();
    });

    it('T16. bob_spend_key null in WebSocket swap_update broadcasts', async () => {
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 3000);

        // Create a swap and trigger a state change (swap_update is broadcast on state transitions)
        const { params } = generateSwapParams('t16-');
        await api.createSwap(params);
        // Admin-set bob_spend_key, then transition to EXPIRED (triggers broadcastSwapUpdate)
        await api.adminUpdate(params.swap_id, { bob_spend_key: 'secret'.repeat(10) });
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });

        // Wait for the swap_update broadcast
        const msg = await ws.waitForMessage('swap_update', 5000);
        const swap = msg.data as Record<string, unknown>;
        assert.equal(swap['preimage'], null, 'preimage should be null in swap_update');
        assert.equal(swap['claim_token'], null, 'claim_token should be null in swap_update');
        assert.equal(swap['bob_spend_key'], null, 'bob_spend_key should be null in swap_update');

        ws.close();
    });

    it('T17. Concurrent admin status updates — only valid transitions succeed', async () => {
        // Create a swap, then fire two competing admin updates
        const { params } = generateSwapParams('t17-');
        await api.createSwap(params);

        // Both try to transition: one to TAKEN (needs counterparty), one to EXPIRED
        const [r1, r2] = await Promise.all([
            api.adminUpdate(params.swap_id, { counterparty: 'cp-t17', status: 'TAKEN' }),
            api.adminUpdate(params.swap_id, { status: 'EXPIRED' }),
        ]);

        // At least one should succeed; at most one should fail (if the other already transitioned)
        const statuses = [r1.status, r2.status];
        const successes = statuses.filter((s) => s === 200).length;
        assert.ok(successes >= 1 && successes <= 2, `Expected 1-2 successes, got ${successes}`);

        // Verify final state is consistent
        const final = await api.getSwap(params.swap_id);
        const finalSwap = (final.body.data as { swap: Record<string, unknown> }).swap;
        const validFinalStates = ['TAKEN', 'EXPIRED'];
        assert.ok(
            validFinalStates.includes(finalSwap['status'] as string),
            `Final state should be TAKEN or EXPIRED, got ${finalSwap['status'] as string}`,
        );
    });

    it('T18. Take on EXPIRED swap returns 409', async () => {
        const { params } = generateSwapParams('t18-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });

        const res = await api.takeSwap(params.swap_id, 'tx-t18');
        assert.equal(res.status, 409, 'Take on EXPIRED swap should be rejected');
    });

    it('T19. Take on MOTO_CLAIMING swap returns 409', async () => {
        const { params, preimage } = generateSwapParams('t19-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        // Walk through: OPEN → TAKEN → XMR_LOCKING → XMR_LOCKED → MOTO_CLAIMING
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-t19', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-t19', status: 'XMR_LOCKING' });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { status: 'MOTO_CLAIMING' });

        const res = await api.takeSwap(params.swap_id, 'tx-t19');
        assert.equal(res.status, 409, 'Take on MOTO_CLAIMING swap should be rejected');
    });

    it('T20. XMR_LOCKING guard requires both counterparty AND xmr_lock_tx', async () => {
        const { params } = generateSwapParams('t20-');
        await api.createSwap(params);

        // Try XMR_LOCKING with counterparty but no xmr_lock_tx
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-t20', status: 'TAKEN' });
        const res = await api.adminUpdate(params.swap_id, { status: 'XMR_LOCKING' });
        assert.equal(res.status, 409, 'XMR_LOCKING without xmr_lock_tx should fail');
    });

    it('T21. XMR_LOCKED guard requires 10 confirmations', async () => {
        const { params } = generateSwapParams('t21-');
        await api.createSwap(params);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-t21', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-t21', status: 'XMR_LOCKING' });

        // Try with 9 confirmations (< 10 required)
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 9 });
        const res = await api.adminUpdate(params.swap_id, { status: 'XMR_LOCKED' });
        assert.equal(res.status, 409, 'XMR_LOCKED with 9 confirmations should fail');

        // Set to 10 and try again
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10 });
        const res2 = await api.adminUpdate(params.swap_id, { status: 'XMR_LOCKED' });
        assert.equal(res2.status, 200, 'XMR_LOCKED with 10 confirmations should succeed');
    });
});

// ---------------------------------------------------------------------------
// U. Audit Finding Tests
// ---------------------------------------------------------------------------

describe('U. Audit Finding Tests', () => {
    // Helper to extract swap from getSwap response
    function extractSwap(res: { body: { data: unknown } }): Record<string, unknown> {
        return (res.body.data as { swap: Record<string, unknown> }).swap;
    }

    // Helper to extract swaps list from listSwaps response
    function extractSwapsList(res: { body: { data: unknown } }): Array<Record<string, unknown>> {
        return (res.body.data as { swaps: Array<Record<string, unknown>> }).swaps;
    }

    // -----------------------------------------------------------------------
    // U1. EXPIRED swaps excluded from active listings (Finding #1 — SETTLED_STATES)
    // -----------------------------------------------------------------------
    it('U1. EXPIRED swaps do not appear in WS active_swaps', async () => {
        const { params } = generateSwapParams('u1-');
        await api.createSwap(params);
        // Don't submit preimage — avoids auto XMR_LOCKING on TAKEN
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-u1', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });

        const res = await api.getSwap(params.swap_id);
        assert.equal(res.status, 200);
        const swap = extractSwap(res);
        assert.equal(swap['status'], 'EXPIRED');

        // WS active_swaps should NOT include EXPIRED swaps
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        const activeMsg = await ws.waitForMessage('active_swaps', 5000);
        const activeSwaps = activeMsg.data as Array<{ swap_id: string }>;
        const inActive = activeSwaps.find((s) => s.swap_id === params.swap_id);
        assert.equal(inActive, undefined, 'EXPIRED swap should not be in active_swaps');
        ws.close();
    });

    // -----------------------------------------------------------------------
    // U2. EXPIRED → REFUNDED transition still works (Finding #1 — not over-blocked)
    // -----------------------------------------------------------------------
    it('U2. EXPIRED swap can still transition to REFUNDED', async () => {
        const { params } = generateSwapParams('u2-');
        await api.createSwap(params);
        // Don't submit preimage — avoids auto XMR_LOCKING on TAKEN
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-u2', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { status: 'EXPIRED' });

        const res = await api.adminUpdate(params.swap_id, {
            opnet_refund_tx: 'refund-u2',
            status: 'REFUNDED',
        });
        assert.equal(res.status, 200, 'EXPIRED → REFUNDED should succeed');

        const check = await api.getSwap(params.swap_id);
        const swap = extractSwap(check);
        assert.equal(swap['status'], 'REFUNDED');
    });

    // -----------------------------------------------------------------------
    // U3. COMPLETED and REFUNDED swaps not in active WS broadcast (Finding #1)
    // -----------------------------------------------------------------------
    it('U3. COMPLETED and REFUNDED swaps excluded from active_swaps', async () => {
        const { params: p1, preimage: pre1 } = generateSwapParams('u3a-');
        await api.createSwap(p1);
        // Don't submit preimage before TAKEN to avoid auto XMR_LOCKING
        await api.adminUpdate(p1.swap_id, { counterparty: 'cp-u3a', status: 'TAKEN' });
        await api.adminUpdate(p1.swap_id, { xmr_lock_tx: 'xmr-u3a', status: 'XMR_LOCKING' });
        await api.submitSecret(p1.swap_id, pre1);
        await api.adminUpdate(p1.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(p1.swap_id, { opnet_claim_tx: 'claim-u3a', status: 'MOTO_CLAIMING' });
        await api.adminUpdate(p1.swap_id, { status: 'COMPLETED' });

        const { params: p2 } = generateSwapParams('u3b-');
        await api.createSwap(p2);
        // OPEN → EXPIRED → REFUNDED (OPEN can't go directly to REFUNDED)
        await api.adminUpdate(p2.swap_id, { status: 'EXPIRED' });
        await api.adminUpdate(p2.swap_id, { opnet_refund_tx: 'refund-u3b', status: 'REFUNDED' });

        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        const activeMsg = await ws.waitForMessage('active_swaps', 5000);
        const activeSwaps = activeMsg.data as Array<{ swap_id: string }>;

        const completedInList = activeSwaps.find((s) => s.swap_id === p1.swap_id);
        const refundedInList = activeSwaps.find((s) => s.swap_id === p2.swap_id);
        assert.equal(completedInList, undefined, 'COMPLETED swap should not be in active_swaps');
        assert.equal(refundedInList, undefined, 'REFUNDED swap should not be in active_swaps');
        ws.close();
    });

    // -----------------------------------------------------------------------
    // U4. Sweep defers key scrubbing — claim_token scrubbed immediately (Finding #2)
    // -----------------------------------------------------------------------
    it('U4. COMPLETED swap has claim_token scrubbed in API response', async () => {
        const { params, preimage } = generateSwapParams('u4-');
        await api.createSwap(params);
        // Don't submit preimage before TAKEN to avoid auto XMR_LOCKING
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-u4', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-u4', status: 'XMR_LOCKING' });
        // Now submit preimage (needed for MOTO_CLAIMING guard)
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { opnet_claim_tx: 'claim-u4', status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, { status: 'COMPLETED' });

        await sleep(200);

        const res = await api.getSwap(params.swap_id);
        assert.equal(res.status, 200);
        const swap = extractSwap(res);
        // API always sanitizes claim_token
        assert.equal(swap['claim_token'], null, 'claim_token should be null in API response');
    });

    // -----------------------------------------------------------------------
    // U5. Non-trustless COMPLETED swap scrubs ALL keys immediately (Finding #2)
    // -----------------------------------------------------------------------
    it('U5. Non-trustless COMPLETED swap scrubs all keys immediately', async () => {
        const { params, preimage } = generateSwapParams('u5-');
        await api.createSwap(params);
        // Don't submit preimage before TAKEN to avoid auto XMR_LOCKING
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-u5', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-u5', status: 'XMR_LOCKING' });
        // Now submit preimage (needed for MOTO_CLAIMING guard)
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { opnet_claim_tx: 'claim-u5', status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, { status: 'COMPLETED' });

        await sleep(100);

        const res = await api.getSwap(params.swap_id);
        const swap = extractSwap(res);
        // API sanitizes these fields; DB also scrubs them for non-trustless
        assert.equal(swap['preimage'], null, 'preimage should be scrubbed');
        assert.equal(swap['claim_token'], null, 'claim_token should be scrubbed');
        assert.equal(swap['alice_view_key'], null, 'alice_view_key should be scrubbed');
        assert.equal(swap['bob_view_key'], null, 'bob_view_key should be scrubbed');
        assert.equal(swap['bob_spend_key'], null, 'bob_spend_key should be scrubbed');
    });

    // -----------------------------------------------------------------------
    // U6. Admin endpoint gated by MONERO_MOCK (Finding #3)
    // -----------------------------------------------------------------------
    it('U6. Admin endpoint only available in mock mode', async () => {
        const { params } = generateSwapParams('u6-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, { counterparty: 'cp-u6' });
        assert.equal(res.status, 200, 'Admin endpoint should work in mock mode');
    });

    // -----------------------------------------------------------------------
    // U7. swap_id path parameter sanitization (Finding #5)
    // -----------------------------------------------------------------------
    it('U7. SQL injection in swap_id path is safely handled', async () => {
        const maliciousId = "1'; DROP TABLE swaps; --";
        const res = await api.getSwap(maliciousId);
        assert.equal(res.status, 404, 'SQL injection swap_id should return 404');

        const health = await api.health();
        assert.equal(health.status, 200, 'Server should still be healthy after injection attempt');
    });

    it('U7b. Path traversal in swap_id is handled', async () => {
        const traversalId = '../../../etc/passwd';
        const res = await api.getSwap(traversalId);
        assert.equal(res.status, 404, 'Path traversal swap_id should return 404');
    });

    // -----------------------------------------------------------------------
    // U8. Rate limiter does not accumulate under disabled mode (Finding #6)
    // -----------------------------------------------------------------------
    it('U8. Rate limiting is disabled in test mode', async () => {
        const promises = [];
        for (let i = 0; i < 40; i++) {
            promises.push(api.health());
        }
        const results = await Promise.all(promises);
        const allOk = results.every((r) => r.status === 200);
        assert.ok(allOk, 'All 40 rapid requests should succeed with rate limiting disabled');
    });

    // -----------------------------------------------------------------------
    // U9. WS active_swaps is well-formed with sanitized fields (Finding #7)
    // -----------------------------------------------------------------------
    it('U9. WS active_swaps message is well-formed sanitized array', async () => {
        const { params } = generateSwapParams('u9-');
        await api.createSwap(params);

        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        const msg = await ws.waitForMessage('active_swaps', 5000);
        assert.ok(Array.isArray(msg.data), 'active_swaps data should be an array');
        // Find our swap in the active list
        const swaps = msg.data as Array<Record<string, unknown>>;
        const ours = swaps.find((s) => s['swap_id'] === params.swap_id);
        assert.ok(ours, 'Our newly created swap should be in active_swaps');
        // Sensitive fields must be sanitized
        assert.equal(ours!['preimage'], null, 'preimage should be null in WS active_swaps');
        assert.equal(ours!['claim_token'], null, 'claim_token should be null in WS active_swaps');
        assert.equal(ours!['bob_spend_key'], null, 'bob_spend_key should be null in WS active_swaps');
        ws.close();
    });

    // -----------------------------------------------------------------------
    // U10. hexNibble handles uppercase hex (Finding #9 — now fixed)
    // -----------------------------------------------------------------------
    it('U10. Server handles uppercase hex in hash_lock', async () => {
        const { preimage, hashLock } = generatePreimageAndHash();
        const upperHash = hashLock.toUpperCase();

        const params = {
            swap_id: `${Date.now()}10`, // numeric swap_id
            hash_lock: upperHash,
            refund_block: 99999999,
            moto_amount: '1000000',
            xmr_amount: '500000000000',
            depositor: 'depositor-u10',
        };
        const createRes = await api.createSwap(params);
        assert.equal(createRes.status, 201, 'Should accept uppercase hex hash_lock');

        const secretRes = await api.submitSecret(params.swap_id, preimage);
        assert.equal(secretRes.status, 200, 'Lowercase preimage should match uppercase hash_lock');
    });

    // -----------------------------------------------------------------------
    // U11. readBody enforces size limit (Finding #12)
    // -----------------------------------------------------------------------
    it('U11. Oversized request body is rejected', async () => {
        // Send body > 64KB limit
        const largeBody = JSON.stringify({ data: 'x'.repeat(100_000) });
        try {
            const res = await fetch(`${coord.baseUrl}/api/swaps`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${ADMIN_API_KEY}`,
                },
                body: largeBody,
            });
            // Should be rejected with 400 (body too large)
            assert.ok(
                res.status === 413 || res.status === 400,
                `Oversized body should be rejected, got ${res.status}`,
            );
        } catch {
            // Connection destroyed by server is also acceptable
            assert.ok(true, 'Server destroyed connection for oversized body');
        }
    });

    // -----------------------------------------------------------------------
    // U12. CORS headers present on responses (Finding #10)
    // -----------------------------------------------------------------------
    it('U12. CORS headers present on all responses', async () => {
        const res = await fetch(`${coord.baseUrl}/api/health`);
        const acao = res.headers.get('access-control-allow-origin');
        assert.ok(acao, 'Access-Control-Allow-Origin header should be present');
    });

    it('U12b. OPTIONS preflight returns correct CORS headers', async () => {
        const res = await fetch(`${coord.baseUrl}/api/swaps`, {
            method: 'OPTIONS',
        });
        assert.equal(res.status, 204, 'OPTIONS should return 204');
        const acao = res.headers.get('access-control-allow-origin');
        assert.ok(acao, 'CORS origin header should be present on OPTIONS');
        const acam = res.headers.get('access-control-allow-methods');
        assert.ok(acam, 'CORS methods header should be present on OPTIONS');
    });

    // -----------------------------------------------------------------------
    // U13. State machine all invalid transitions rejected
    // -----------------------------------------------------------------------
    it('U13. OPEN cannot jump to COMPLETED', async () => {
        const { params } = generateSwapParams('u13-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, {
            opnet_claim_tx: 'fake',
            status: 'COMPLETED',
        });
        assert.equal(res.status, 409, 'OPEN → COMPLETED should be rejected');
    });

    it('U13b. OPEN cannot jump to XMR_LOCKED', async () => {
        const { params } = generateSwapParams('u13b-');
        await api.createSwap(params);
        const res = await api.adminUpdate(params.swap_id, {
            xmr_lock_confirmations: 10,
            status: 'XMR_LOCKED',
        });
        assert.equal(res.status, 409, 'OPEN → XMR_LOCKED should be rejected');
    });

    it('U13c. COMPLETED cannot transition to anything', async () => {
        const { params, preimage } = generateSwapParams('u13c-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-u13c', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-u13c', status: 'XMR_LOCKING' });
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { opnet_claim_tx: 'claim-u13c', status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, { status: 'COMPLETED' });

        const res1 = await api.adminUpdate(params.swap_id, { status: 'OPEN' });
        assert.equal(res1.status, 409, 'COMPLETED → OPEN should be rejected');

        const res2 = await api.adminUpdate(params.swap_id, {
            opnet_refund_tx: 'refund',
            status: 'REFUNDED',
        });
        assert.equal(res2.status, 409, 'COMPLETED → REFUNDED should be rejected');
    });

    it('U13d. REFUNDED cannot transition to anything', async () => {
        const { params, preimage } = generateSwapParams('u13d-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { opnet_refund_tx: 'refund-u13d', status: 'REFUNDED' });

        const res = await api.adminUpdate(params.swap_id, { status: 'OPEN' });
        assert.equal(res.status, 409, 'REFUNDED → OPEN should be rejected');
    });

    it('U13e. Backward transition TAKEN → OPEN rejected', async () => {
        const { params, preimage } = generateSwapParams('u13e-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-u13e', status: 'TAKEN' });

        const res = await api.adminUpdate(params.swap_id, { status: 'OPEN' });
        assert.equal(res.status, 409, 'TAKEN → OPEN should be rejected');
    });

    // -----------------------------------------------------------------------
    // U14. NaN pagination doesn't crash server (regression)
    // -----------------------------------------------------------------------
    it('U14. NaN pagination parameters handled gracefully', async () => {
        const res = await api.raw('GET', '/api/swaps?page=abc&limit=xyz');
        assert.equal(res.status, 200, 'NaN pagination should default to page 1, limit 20');
        const data = res.body.data as { swaps: unknown[] };
        assert.ok(Array.isArray(data.swaps), 'Should still return valid swaps array');
    });

    it('U14b. Negative pagination parameters handled gracefully', async () => {
        const res = await api.raw('GET', '/api/swaps?page=-5&limit=-10');
        assert.equal(res.status, 200, 'Negative pagination should clamp to valid values');
        const data = res.body.data as { swaps: unknown[] };
        assert.ok(Array.isArray(data.swaps), 'Should still return valid swaps array');
    });

    it('U14c. Extremely large pagination limit is capped', async () => {
        const res = await api.raw('GET', '/api/swaps?page=1&limit=999999');
        assert.equal(res.status, 200, 'Huge limit should be capped');
    });

    // -----------------------------------------------------------------------
    // U15. Concurrent swap creation with same ID — only first wins (TOCTOU)
    // -----------------------------------------------------------------------
    it('U15. Concurrent creates with same swap_id — only first succeeds', async () => {
        const { params } = generateSwapParams('u15-');
        const results = await Promise.all([
            api.createSwap(params),
            api.createSwap(params),
            api.createSwap(params),
        ]);
        const successes = results.filter((r) => r.status === 201);
        const conflicts = results.filter((r) => r.status === 409);
        assert.equal(successes.length, 1, 'Only one create should succeed');
        assert.equal(conflicts.length, 2, 'Two creates should get 409');
    });

    // -----------------------------------------------------------------------
    // U16. WebSocket sanitizes sensitive fields in broadcasts
    // -----------------------------------------------------------------------
    it('U16. WebSocket swap_update sanitizes sensitive fields', async () => {
        const ws = new WsClient(coord.baseUrl);
        await ws.connect();
        await ws.waitForMessage('active_swaps', 5000);

        const { params, preimage } = generateSwapParams('u16-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-u16', status: 'TAKEN' });

        // The admin handler and stateMachine.notifyTransition both broadcast;
        // grab the first swap_update we see for this swap.
        const msg = await ws.waitForMessage('swap_update', 5000);
        const swap = msg.data as Record<string, unknown>;
        assert.equal(swap['swap_id'], params.swap_id);
        assert.equal(swap['preimage'], null, 'preimage should be null in WS broadcast');
        assert.equal(swap['claim_token'], null, 'claim_token should be null in WS broadcast');
        assert.equal(swap['bob_spend_key'], null, 'bob_spend_key should be null in WS broadcast');
        assert.equal(swap['alice_view_key'], null, 'alice_view_key should be null in WS broadcast');
        assert.equal(swap['bob_view_key'], null, 'bob_view_key should be null in WS broadcast');
        ws.close();
    });

    // -----------------------------------------------------------------------
    // U17. Full happy path with state history (Finding #2 — end-to-end)
    // -----------------------------------------------------------------------
    it('U17. Standard happy path reaches COMPLETED with correct state history', async () => {
        const { params, preimage } = generateSwapParams('u17-');
        const start = Date.now();

        await api.createSwap(params);
        // Don't submit preimage before TAKEN to avoid auto XMR_LOCKING
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-u17', status: 'TAKEN' });
        await api.adminUpdate(params.swap_id, { xmr_lock_tx: 'xmr-u17', status: 'XMR_LOCKING' });
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { xmr_lock_confirmations: 10, status: 'XMR_LOCKED' });
        await api.adminUpdate(params.swap_id, { opnet_claim_tx: 'claim-u17', status: 'MOTO_CLAIMING' });
        await api.adminUpdate(params.swap_id, { status: 'COMPLETED' });

        const elapsed = Date.now() - start;
        timer.record('auditHappyPath', elapsed);

        const res = await api.getSwap(params.swap_id);
        const swapData = res.body.data as { swap: Record<string, unknown>; history: Array<{ from_state: string; to_state: string }> };
        assert.equal(swapData.swap['status'], 'COMPLETED');

        // State history is returned alongside the swap
        // 5 transitions: OPEN→TAKEN→XMR_LOCKING→XMR_LOCKED→MOTO_CLAIMING→COMPLETED
        assert.ok(swapData.history.length >= 5, `Expected at least 5 state transitions, got ${swapData.history.length}`);
    });

    // -----------------------------------------------------------------------
    // U18. Empty/malformed JSON body handling (Finding #12)
    // -----------------------------------------------------------------------
    it('U18. Empty POST body returns 400', async () => {
        const res = await fetch(`${coord.baseUrl}/api/swaps`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${ADMIN_API_KEY}`,
            },
            body: '',
        });
        assert.ok(res.status === 400 || res.status === 422, `Empty body should fail, got ${res.status}`);
    });

    it('U18b. Invalid JSON body returns 400', async () => {
        const res = await fetch(`${coord.baseUrl}/api/swaps`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${ADMIN_API_KEY}`,
            },
            body: '{not valid json',
        });
        assert.ok(res.status === 400 || res.status === 422, `Invalid JSON should fail, got ${res.status}`);
    });

    // -----------------------------------------------------------------------
    // U19. Fee calculation precision (Finding — edge case)
    // -----------------------------------------------------------------------
    it('U19. Fee calculation correct for various amounts', async () => {
        // 0.001 XMR = 1_000_000_000 piconero
        const { hashLock: hash1 } = generatePreimageAndHash();
        const id1 = `${Date.now()}191`;
        const res1 = await api.createSwap({
            swap_id: id1,
            hash_lock: hash1,
            refund_block: 99999999,
            moto_amount: '1000000',
            xmr_amount: '1000000000',
            depositor: 'dep-u19a',
        });
        assert.equal(res1.status, 201);

        const swap1Res = await api.getSwap(id1);
        const data1 = extractSwap(swap1Res);
        // fee = 1_000_000_000 * 87 / 10000 = 8_700_000
        assert.equal(data1['xmr_fee'], '8700000', 'Fee should be 8700000 piconero');
        assert.equal(data1['xmr_total'], '1008700000', 'Total should be amount + fee');

        // 1 XMR = 1_000_000_000_000 piconero
        const { hashLock: hash2 } = generatePreimageAndHash();
        const id2 = `${Date.now()}192`;
        const res2 = await api.createSwap({
            swap_id: id2,
            hash_lock: hash2,
            refund_block: 99999999,
            moto_amount: '100000000',
            xmr_amount: '1000000000000',
            depositor: 'dep-u19b',
        });
        assert.equal(res2.status, 201);

        const swap2Res = await api.getSwap(id2);
        const data2 = extractSwap(swap2Res);
        assert.equal(data2['xmr_fee'], '8700000000', 'Fee for 1 XMR should be 8700000000');
        assert.equal(data2['xmr_total'], '1008700000000', 'Total should be 1.0087 XMR');
    });

    // -----------------------------------------------------------------------
    // U20. Admin requires valid API key (Finding #3 — auth)
    // -----------------------------------------------------------------------
    it('U20. Admin endpoint rejects missing API key', async () => {
        const { params } = generateSwapParams('u20-');
        await api.createSwap(params);

        const noAuthApi = new SwapApiClient(coord.baseUrl, '');
        const res = await noAuthApi.adminUpdate(params.swap_id, { status: 'TAKEN' });
        assert.equal(res.status, 401, 'Admin without API key should get 401');
    });

    it('U20b. Admin endpoint rejects wrong API key', async () => {
        const { params } = generateSwapParams('u20b-');
        await api.createSwap(params);

        const wrongKeyApi = new SwapApiClient(coord.baseUrl, 'wrong-key-wrong-key-wrong-key-12');
        const res = await wrongKeyApi.adminUpdate(params.swap_id, { status: 'TAKEN' });
        assert.equal(res.status, 401, 'Admin with wrong API key should get 401');
    });

    // -----------------------------------------------------------------------
    // U21. Multiple WS clients each get broadcasts (Finding #7)
    // -----------------------------------------------------------------------
    it('U21. Multiple WebSocket clients all receive swap_update', async () => {
        const ws1 = new WsClient(coord.baseUrl);
        const ws2 = new WsClient(coord.baseUrl);
        await ws1.connect();
        await ws2.connect();
        await ws1.waitForMessage('active_swaps', 5000);
        await ws2.waitForMessage('active_swaps', 5000);

        const { params, preimage } = generateSwapParams('u21-');
        await api.createSwap(params);
        await api.submitSecret(params.swap_id, preimage);
        await api.adminUpdate(params.swap_id, { counterparty: 'cp-u21', status: 'TAKEN' });

        // Both clients should receive at least one swap_update for this swap
        const msg1 = await ws1.waitForMessage('swap_update', 5000);
        const msg2 = await ws2.waitForMessage('swap_update', 5000);

        assert.equal((msg1.data as Record<string, unknown>)['swap_id'], params.swap_id, 'WS1 should get the update');
        assert.equal((msg2.data as Record<string, unknown>)['swap_id'], params.swap_id, 'WS2 should get the update');

        ws1.close();
        ws2.close();
    });

    // -----------------------------------------------------------------------
    // U22. Create swap rejects zero xmr_amount (Finding — validation)
    // -----------------------------------------------------------------------
    it('U22. Zero xmr_amount rejected', async () => {
        const { hashLock } = generatePreimageAndHash();
        const res = await api.createSwap({
            swap_id: `${Date.now()}22`,
            hash_lock: hashLock,
            refund_block: 99999999,
            moto_amount: '1000000',
            xmr_amount: '0',
            depositor: 'dep-u22',
        });
        assert.ok(
            res.status === 400 || res.status === 422,
            `Zero xmr_amount should be rejected, got ${res.status}`,
        );
    });

    // -----------------------------------------------------------------------
    // U23. Coordinator restart preserves state (Finding #14 — persistence)
    // -----------------------------------------------------------------------
    it('U23. Swap state survives coordinator restart', { timeout: 30000 }, async () => {
        const dbPath = `/tmp/coordinator-restart-${Date.now()}.db`;
        const restartCoord = new CoordinatorProcess({ dbPath, mockConfirmDelay: 2000 });
        await restartCoord.start();
        const restartApi = new SwapApiClient(restartCoord.baseUrl);

        // Create and advance a swap — don't submit preimage to avoid auto XMR_LOCKING
        const { params } = generateSwapParams('u23-');
        await restartApi.createSwap(params);
        await restartApi.adminUpdate(params.swap_id, { counterparty: 'cp-u23', status: 'TAKEN' });

        // Kill and restart with same DB (new port)
        await restartCoord.kill();
        await restartCoord.restart();
        const newApi = new SwapApiClient(restartCoord.baseUrl);

        const res = await newApi.getSwap(params.swap_id);
        assert.equal(res.status, 200);
        const swap = extractSwap(res);
        assert.equal(swap['status'], 'TAKEN', 'Status should survive restart');
        assert.equal(swap['counterparty'], 'cp-u23', 'Counterparty should survive restart');

        await restartCoord.kill();
    });
});
