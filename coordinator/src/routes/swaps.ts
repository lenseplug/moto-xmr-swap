/**
 * Route handlers for swap REST API endpoints.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    type IApiError,
    type IApiResponse,
    type ICreateSwapParams,
    type IPaginationParams,
    type ISwapRecord,
    type IUpdateSwapParams,
    type ITakeSwapBody,
    SwapStatus,
    calculateXmrFee,
    calculateXmrTotal,
    safeParseAmount,
    MIN_XMR_AMOUNT_PICONERO,
} from '../types.js';
import { StorageService } from '../storage.js';
import { SwapStateMachine } from '../state-machine.js';
import { SwapWebSocketServer } from '../websocket.js';
import { randomBytes } from 'node:crypto';
import { getFeeAddress, setFeeAddress, verifyPreimage, validateMoneroAddress } from '../monero-module.js';
import { ed25519PublicFromPrivate, verifyBobKeyProof } from '../crypto/index.js';

// ---------------------------------------------------------------------------
// Per-swap operation lock to prevent TOCTOU races
// ---------------------------------------------------------------------------

const swapOperationLocks = new Map<string, Promise<void>>();

/**
 * Serializes concurrent operations on the same swap.
 * Prevents TOCTOU race conditions where two requests check state simultaneously.
 */
async function withSwapLock<T>(swapId: string, fn: () => Promise<T>): Promise<T> {
    const prev = swapOperationLocks.get(swapId) ?? Promise.resolve();
    let releaseLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
    swapOperationLocks.set(swapId, lockPromise);

    await prev;

    try {
        return await fn();
    } finally {
        releaseLock();
        if (swapOperationLocks.get(swapId) === lockPromise) {
            swapOperationLocks.delete(swapId);
        }
    }
}

/** Returns a structured success response. */
function success<T>(data: T): IApiResponse<T> {
    return { success: true, data, error: null };
}

/** Returns a structured error response. */
function fail(code: string, message: string, retryable = false): IApiResponse<never> {
    const error: IApiError = { code, message, retryable };
    return { success: false, data: null, error };
}

const MAX_BODY_BYTES = 65536;

/** Reads and parses the request body as JSON. Enforces a maximum body size. */
async function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let raw = '';
        let bytesRead = 0;
        let destroyed = false;

        req.on('data', (chunk: Uint8Array | string) => {
            if (destroyed) return;
            const len =
                typeof chunk === 'string'
                    ? new TextEncoder().encode(chunk).byteLength
                    : chunk.length;
            bytesRead += len;
            if (bytesRead > MAX_BODY_BYTES) {
                destroyed = true;
                req.destroy(new Error('Request body too large'));
                reject(new Error('Request body too large'));
                return;
            }
            if (typeof chunk === 'string') {
                raw += chunk;
            } else if (chunk instanceof Uint8Array) {
                raw += new TextDecoder().decode(chunk);
            }
        });
        req.on('end', () => {
            if (destroyed) return;
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/** Sends a JSON response with the given status code. */
function jsonResponse<T>(res: ServerResponse, statusCode: number, body: IApiResponse<T>): void {
    const json = JSON.stringify(body);
    const encoded = new TextEncoder().encode(json);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': encoded.byteLength,
    });
    res.end(json);
}

/** Extracts pagination params from URL query string. */
function parsePagination(url: URL): IPaginationParams {
    const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '20', 10);
    const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
    const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));
    return { page, limit };
}

/**
 * Strips sensitive fields (preimage) from a swap record before sending to clients.
 * The preimage is ONLY delivered via WebSocket, never via HTTP.
 */
function sanitizeSwapForApi(swap: ISwapRecord): Omit<ISwapRecord, 'preimage' | 'claim_token' | 'alice_view_key' | 'bob_view_key' | 'bob_spend_key'> & { preimage: null; claim_token: null; alice_view_key: null; bob_view_key: null; bob_spend_key: null } {
    return { ...swap, preimage: null, claim_token: null, alice_view_key: null, bob_view_key: null, bob_spend_key: null };
}

/** Handler: GET /api/health */
export function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    jsonResponse(res, 200, success({ status: 'ok', timestamp: new Date().toISOString() }));
}

/** Handler: GET /api/swaps */
export function handleListSwaps(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
): void {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const { page, limit } = parsePagination(url);
    const swaps = storage.listSwaps(page, limit);
    const sanitized = swaps.map(sanitizeSwapForApi);
    jsonResponse(res, 200, success({ swaps: sanitized, page, limit }));
}

/** Handler: GET /api/swaps/:id */
export function handleGetSwap(
    _req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
): void {
    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
        return;
    }
    const history = storage.getStateHistory(swapId);
    jsonResponse(res, 200, success({ swap: sanitizeSwapForApi(swap), history }));
}

/**
 * Handler: POST /api/swaps/:id/take
 *
 * Accepts only { opnetTxId: string }.
 * The actual counterparty address is authoritative from the on-chain watcher,
 * not from the caller — preventing self-reported counterparty spoofing.
 */
export async function handleTakeSwap(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
): Promise<void> {
    // Per-swap lock prevents TOCTOU race: two concurrent take requests
    // can no longer both pass the claim_token check simultaneously.
    return withSwapLock(swapId, async () => {
        const swap = storage.getSwap(swapId);
        if (!swap) {
            jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
            return;
        }

        // Allow take when OPEN, TAKEN, XMR_LOCKING, or XMR_LOCKED.
        // The OPNet watcher may transition to TAKEN and startXmrLocking may progress
        // to XMR_LOCKING/XMR_LOCKED before Bob's POST /take arrives (race condition).
        // The double-take guard below prevents multiple claim_token assignments.
        const TAKE_ALLOWED_STATES: ReadonlySet<SwapStatus> = new Set([
            SwapStatus.OPEN,
            SwapStatus.TAKEN,
            SwapStatus.XMR_LOCKING,
            SwapStatus.XMR_LOCKED,
        ]);
        if (!TAKE_ALLOWED_STATES.has(swap.status)) {
            jsonResponse(res, 409, fail('INVALID_STATE', `Swap cannot be taken (current: ${swap.status})`));
            return;
        }

        // Prevent double-take: reject if claim_token already assigned
        if (swap.claim_token && swap.claim_token.length > 0) {
            jsonResponse(res, 409, fail('ALREADY_TAKEN', 'Swap has already been taken'));
            return;
        }

        let body: ITakeSwapBody;
        try {
            const parsed = await readBody(req);
            if (
                typeof parsed !== 'object' ||
                parsed === null ||
                !('opnetTxId' in parsed) ||
                typeof (parsed as { opnetTxId: unknown }).opnetTxId !== 'string'
            ) {
                jsonResponse(res, 400, fail('VALIDATION', 'opnetTxId (string) is required'));
                return;
            }
            body = parsed as ITakeSwapBody;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Invalid request';
            jsonResponse(res, 400, fail('INVALID_BODY', msg));
            return;
        }

        if (!body.opnetTxId || body.opnetTxId.trim().length === 0) {
            jsonResponse(res, 400, fail('VALIDATION', 'opnetTxId must not be empty'));
            return;
        }

        // Re-check under lock (defense-in-depth)
        const freshSwap = storage.getSwap(swapId);
        if (freshSwap && freshSwap.claim_token && freshSwap.claim_token.length > 0) {
            jsonResponse(res, 409, fail('ALREADY_TAKEN', 'Swap has already been taken'));
            return;
        }

        // Generate a one-time claim_token for authenticated WebSocket subscription
        const claimToken = randomBytes(32).toString('hex');
        storage.updateSwap(swapId, { claim_token: claimToken });

        jsonResponse(res, 200, success({
            swap: sanitizeSwapForApi(freshSwap ?? swap),
            opnetTxId: body.opnetTxId.trim(),
            claim_token: claimToken,
        }));
    });
}

/**
 * Handler: POST /api/swaps/:id/secret
 *
 * Accepts { secret: string } (64-char hex preimage).
 * Validates SHA-256(secret) == hash_lock, then stores in DB.
 * The preimage is ONLY revealed to subscribers via WebSocket.
 */
export async function handleSubmitSecret(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
): Promise<void> {
    // Per-swap lock prevents concurrent preimage submissions from both
    // passing the null check before either stores.
    return withSwapLock(swapId, async () => {
        const swap = storage.getSwap(swapId);
        if (!swap) {
            jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
            return;
        }

        // Accept secrets for OPEN (Alice submits right after creation), TAKEN (normal flow),
        // and later pre-claim states (idempotent re-submission).
        const ACCEPT_SECRET_STATES = new Set([
            SwapStatus.OPEN,
            SwapStatus.TAKEN,
            SwapStatus.XMR_LOCKING,
            SwapStatus.XMR_LOCKED,
        ]);
        if (!ACCEPT_SECRET_STATES.has(swap.status)) {
            jsonResponse(
                res,
                409,
                fail('INVALID_STATE', `Swap is in state ${swap.status} — cannot accept secret`),
            );
            return;
        }

        let secret: string;
        let aliceViewKey: string | undefined;
        try {
            const parsed = await readBody(req);
            if (
                typeof parsed !== 'object' ||
                parsed === null ||
                !('secret' in parsed) ||
                typeof (parsed as { secret: unknown }).secret !== 'string'
            ) {
                jsonResponse(res, 400, fail('VALIDATION', 'secret (string) is required'));
                return;
            }
            secret = (parsed as { secret: string }).secret.trim().toLowerCase();
            const candidate = parsed as Record<string, unknown>;
            if (typeof candidate['aliceViewKey'] === 'string') {
                aliceViewKey = candidate['aliceViewKey'].trim().toLowerCase();
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Invalid request';
            jsonResponse(res, 400, fail('INVALID_BODY', msg));
            return;
        }

        if (!/^[0-9a-f]{64}$/.test(secret)) {
            jsonResponse(res, 400, fail('VALIDATION', 'Secret must be exactly 64 hex characters'));
            return;
        }

        if (aliceViewKey !== undefined && !/^[0-9a-f]{64}$/.test(aliceViewKey)) {
            jsonResponse(res, 400, fail('VALIDATION', 'aliceViewKey must be exactly 64 hex characters'));
            return;
        }

        if (!verifyPreimage(secret, swap.hash_lock)) {
            jsonResponse(
                res,
                400,
                fail('HASH_MISMATCH', 'SHA-256(secret) does not match the swap hash lock'),
            );
            return;
        }

        // Re-check preimage under lock (defense-in-depth)
        const freshSwap = storage.getSwap(swapId);
        if (freshSwap && freshSwap.preimage !== null && freshSwap.preimage.length > 0) {
            if (freshSwap.preimage === secret) {
                jsonResponse(res, 200, success({ stored: true, trustless: freshSwap.trustless_mode === 1 }));
                return;
            }
            jsonResponse(res, 409, fail('ALREADY_SET', 'A different preimage is already stored for this swap'));
            return;
        }

        const updateParams: Record<string, string | number | null> = { preimage: secret };

        if (aliceViewKey) {
            const secretBytes = hexToBytes(secret);
            const alicePub = ed25519PublicFromPrivate(secretBytes);
            const alicePubHex = bytesToHex(alicePub);
            updateParams['trustless_mode'] = 1;
            updateParams['alice_ed25519_pub'] = alicePubHex;
            updateParams['alice_view_key'] = aliceViewKey;
            console.log(`[Routes] Split-key mode enabled for swap ${swapId}`);
        }

        storage.updateSwap(swapId, updateParams as import('../types.js').IUpdateSwapParams);
        console.log(`[Routes] Secret stored for swap ${swapId}`);

        jsonResponse(res, 200, success({ stored: true, trustless: !!aliceViewKey }));
    });
}

/** Handler: POST /api/swaps (create a new swap record — coordinator internal use) */
export async function handleCreateSwap(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
): Promise<void> {
    let body: ICreateSwapParams;
    try {
        const parsed = await readBody(req);
        if (typeof parsed !== 'object' || parsed === null) {
            jsonResponse(res, 400, fail('VALIDATION', 'Request body must be a JSON object'));
            return;
        }
        const candidate = parsed as Record<string, unknown>;
        if (
            typeof candidate['swap_id'] !== 'string' ||
            typeof candidate['hash_lock'] !== 'string' ||
            typeof candidate['refund_block'] !== 'number' ||
            typeof candidate['moto_amount'] !== 'string' ||
            typeof candidate['xmr_amount'] !== 'string' ||
            typeof candidate['depositor'] !== 'string'
        ) {
            jsonResponse(
                res,
                400,
                fail(
                    'VALIDATION',
                    'Required fields: swap_id, hash_lock, refund_block, moto_amount, xmr_amount, depositor',
                ),
            );
            return;
        }
        // Extract validated fields (types already checked above)
        const swapId = candidate['swap_id'];
        const hashLock = candidate['hash_lock'];
        const refundBlock = candidate['refund_block'];
        const motoAmount = candidate['moto_amount'];
        const xmrAmount = candidate['xmr_amount'];
        const depositorAddr = candidate['depositor'];

        // Validate hash_lock format: exactly 64 hex characters
        if (!/^[0-9a-f]{64}$/i.test(hashLock)) {
            jsonResponse(res, 400, fail('VALIDATION', 'hash_lock must be exactly 64 hex characters'));
            return;
        }

        // Validate swap_id format: numeric string (on-chain swap ID is a uint256)
        if (!/^[0-9]+$/.test(swapId) || swapId.length > 78) {
            jsonResponse(res, 400, fail('VALIDATION', 'swap_id must be a numeric string'));
            return;
        }

        // Validate amount strings are valid non-negative integers
        const xmrParsed = safeParseAmount(xmrAmount);
        if (xmrParsed === null || xmrParsed <= 0n) {
            jsonResponse(res, 400, fail('VALIDATION', 'xmr_amount must be a positive integer string'));
            return;
        }
        const motoParsed = safeParseAmount(motoAmount);
        if (motoParsed === null || motoParsed <= 0n) {
            jsonResponse(res, 400, fail('VALIDATION', 'moto_amount must be a positive integer string'));
            return;
        }
        if (xmrParsed < MIN_XMR_AMOUNT_PICONERO) {
            jsonResponse(res, 400, fail('VALIDATION', `xmr_amount below minimum (${MIN_XMR_AMOUNT_PICONERO} piconero = 0.001 XMR)`));
            return;
        }
        // Validate refund_block is positive
        if (refundBlock <= 0) {
            jsonResponse(res, 400, fail('VALIDATION', 'refund_block must be a positive number'));
            return;
        }

        // Optional: Alice's XMR payout address (where she receives XMR after completion)
        let aliceXmrPayout: string | null = null;
        if (typeof candidate['alice_xmr_payout'] === 'string' && candidate['alice_xmr_payout'].length > 0) {
            aliceXmrPayout = candidate['alice_xmr_payout'].trim();
            const addrErr = validateMoneroAddress(aliceXmrPayout);
            if (addrErr !== null) {
                jsonResponse(res, 400, fail('VALIDATION', `Invalid alice_xmr_payout: ${addrErr}`));
                return;
            }
        }

        body = {
            swap_id: swapId,
            hash_lock: hashLock,
            refund_block: refundBlock,
            moto_amount: motoAmount,
            xmr_amount: xmrAmount,
            xmr_fee: calculateXmrFee(xmrAmount),
            xmr_total: calculateXmrTotal(xmrAmount),
            xmr_address: null, // Never accept user-supplied xmr_address — coordinator generates it
            depositor: depositorAddr,
            opnet_create_tx:
                typeof candidate['opnet_create_tx'] === 'string' &&
                /^[0-9a-f]{64}$/i.test(candidate['opnet_create_tx'])
                    ? candidate['opnet_create_tx']
                    : null,
            alice_xmr_payout: aliceXmrPayout,
        };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    const existing = storage.getSwap(body.swap_id);
    if (existing) {
        jsonResponse(res, 409, fail('CONFLICT', `Swap ${body.swap_id} already exists`));
        return;
    }

    try {
        const created = storage.createSwap(body);
        jsonResponse(res, 201, success<ISwapRecord>({ ...created }));
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Storage error';
        jsonResponse(res, 500, fail('STORAGE_ERROR', message, true));
    }
}

/** Handler: GET /api/fee-address — returns the current XMR fee wallet address. */
export function handleGetFeeAddress(_req: IncomingMessage, res: ServerResponse): void {
    jsonResponse(res, 200, success({ feeAddress: getFeeAddress(), feeBps: 87 }));
}

/** Handler: PUT /api/fee-address — updates the XMR fee wallet address. */
export async function handleSetFeeAddress(
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    let address: string;
    try {
        const parsed = await readBody(req);
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !('address' in parsed) ||
            typeof (parsed as { address: unknown }).address !== 'string'
        ) {
            jsonResponse(res, 400, fail('VALIDATION', 'address (string) is required'));
            return;
        }
        address = (parsed as { address: string }).address;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    try {
        setFeeAddress(address);
        jsonResponse(res, 200, success({ feeAddress: getFeeAddress(), feeBps: 87 }));
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Validation error';
        jsonResponse(res, 400, fail('VALIDATION', message));
    }
}

/**
 * Handler: POST /api/swaps/:id/keys
 *
 * Accepts Bob's key material for split-key mode:
 *   { bobEd25519PubKey: string, bobViewKey: string, bobKeyProof: string }
 *
 * The swap must already be in split-key mode (Alice submitted aliceViewKey with secret).
 * Once Bob's keys are stored, the coordinator can compute the shared Monero address.
 * NOTE: The coordinator holds both key shares and is trusted with the XMR side.
 */
export async function handleSubmitKeys(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    swapId: string,
): Promise<void> {
    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
        return;
    }

    // Must be in split-key mode
    if (swap.trustless_mode !== 1) {
        jsonResponse(res, 409, fail('NOT_TRUSTLESS', 'Swap is not in split-key mode — Alice must submit aliceViewKey with secret first'));
        return;
    }

    // Only accept keys when swap is TAKEN or later pre-XMR states
    const ACCEPT_KEYS_STATES = new Set([
        SwapStatus.TAKEN,
        SwapStatus.XMR_LOCKING,
        SwapStatus.XMR_LOCKED,
    ]);
    if (!ACCEPT_KEYS_STATES.has(swap.status)) {
        jsonResponse(res, 409, fail('INVALID_STATE', `Swap is in state ${swap.status} — cannot accept keys`));
        return;
    }

    // Reject if Bob's keys are already set
    if (swap.bob_ed25519_pub && swap.bob_ed25519_pub.length > 0) {
        jsonResponse(res, 200, success({ stored: true, message: 'Bob keys already stored' }));
        return;
    }

    let bobPub: string;
    let bobViewKey: string;
    let bobKeyProof: string;
    let bobSpendKey: string | undefined;
    try {
        const parsed = await readBody(req);
        const candidate = parsed as Record<string, unknown>;
        if (
            typeof candidate['bobEd25519PubKey'] !== 'string' ||
            typeof candidate['bobViewKey'] !== 'string' ||
            typeof candidate['bobKeyProof'] !== 'string'
        ) {
            jsonResponse(res, 400, fail('VALIDATION', 'Required: bobEd25519PubKey, bobViewKey, bobKeyProof (all hex strings)'));
            return;
        }
        bobPub = candidate['bobEd25519PubKey'].trim().toLowerCase();
        bobViewKey = candidate['bobViewKey'].trim().toLowerCase();
        bobKeyProof = candidate['bobKeyProof'].trim().toLowerCase();
        // Optional: Bob's private spend key (needed for coordinator to sweep XMR after completion)
        if (typeof candidate['bobSpendKey'] === 'string') {
            bobSpendKey = candidate['bobSpendKey'].trim().toLowerCase();
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    // Validate formats
    if (!/^[0-9a-f]{64}$/.test(bobPub)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobEd25519PubKey must be exactly 64 hex characters'));
        return;
    }
    if (!/^[0-9a-f]{64}$/.test(bobViewKey)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobViewKey must be exactly 64 hex characters'));
        return;
    }
    // Key proof must be exactly 128 hex chars (64 bytes: R || s)
    if (!/^[0-9a-f]{128}$/.test(bobKeyProof)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobKeyProof must be exactly 128 hex characters (64 bytes)'));
        return;
    }

    // Validate bobSpendKey if provided
    if (bobSpendKey !== undefined && !/^[0-9a-f]{64}$/.test(bobSpendKey)) {
        jsonResponse(res, 400, fail('VALIDATION', 'bobSpendKey must be exactly 64 hex characters'));
        return;
    }

    // Verify Bob's proof-of-knowledge: proves he knows the private key behind bobPub
    const proofBytes = hexToBytes(bobKeyProof);
    const pubBytes = hexToBytes(bobPub);
    if (!verifyBobKeyProof(pubBytes, proofBytes, swapId)) {
        jsonResponse(res, 400, fail('KEY_PROOF_INVALID', 'Bob key proof-of-knowledge verification failed — cannot prove ownership of submitted public key'));
        return;
    }

    // Store Bob's key material (proof stored in bob_dleq_proof column for backward compat)
    storage.updateSwap(swapId, {
        bob_ed25519_pub: bobPub,
        bob_view_key: bobViewKey,
        bob_dleq_proof: bobKeyProof,
        ...(bobSpendKey !== undefined ? { bob_spend_key: bobSpendKey } : {}),
    });
    console.log(`[Routes] Bob's keys verified and stored for split-key swap ${swapId}`);

    jsonResponse(res, 200, success({ stored: true }));
}

/**
 * Handler: PUT /api/admin/swaps/:id
 *
 * Test-only endpoint gated by MONERO_MOCK=true.
 * Allows tests to simulate on-chain state changes (OPEN → TAKEN, etc.)
 * without the OPNet watcher. Validates transitions via the state machine.
 */
export async function handleAdminUpdateSwap(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    stateMachine: SwapStateMachine,
    wsServer: SwapWebSocketServer,
    swapId: string,
): Promise<void> {
    // Gate: only available when MONERO_MOCK=true
    const isMock = (process.env['MONERO_MOCK'] ?? 'false').toLowerCase() === 'true';
    if (!isMock) {
        jsonResponse(res, 403, fail('FORBIDDEN', 'Admin state endpoint is only available in mock mode'));
        return;
    }

    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
        return;
    }

    let updates: Record<string, unknown>;
    try {
        const parsed = await readBody(req);
        if (typeof parsed !== 'object' || parsed === null) {
            jsonResponse(res, 400, fail('VALIDATION', 'Request body must be a JSON object'));
            return;
        }
        updates = parsed as Record<string, unknown>;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    // Build IUpdateSwapParams from the request body
    const updateParams: Record<string, string | number | null | undefined> = {};
    const allowedFields: ReadonlyArray<string> = [
        'status', 'counterparty', 'opnet_claim_tx', 'opnet_refund_tx',
        'xmr_lock_tx', 'xmr_lock_confirmations', 'xmr_address',
        'xmr_subaddr_index', 'preimage', 'claim_token',
        'trustless_mode', 'alice_ed25519_pub', 'alice_view_key',
        'bob_ed25519_pub', 'bob_view_key', 'bob_spend_key',
        'bob_dleq_proof', 'alice_xmr_payout', 'sweep_status',
    ];

    for (const field of allowedFields) {
        if (field in updates) {
            const val = updates[field];
            if (val === null || typeof val === 'string' || typeof val === 'number') {
                updateParams[field] = val;
            }
        }
    }

    // If status change requested, validate the transition
    const newStatus = updateParams['status'];
    if (typeof newStatus === 'string') {
        // Verify it's a valid SwapStatus
        if (!Object.values(SwapStatus).includes(newStatus as SwapStatus)) {
            jsonResponse(res, 400, fail('VALIDATION', `Invalid status: ${newStatus}`));
            return;
        }

        // Apply non-status fields first (guards may need them)
        const preFields: Record<string, string | number | null | undefined> = { ...updateParams };
        delete preFields['status'];
        if (Object.keys(preFields).length > 0) {
            storage.updateSwap(swapId, preFields as IUpdateSwapParams);
        }

        // Re-fetch after pre-fields applied, then validate transition
        const freshSwap = storage.getSwap(swapId);
        if (!freshSwap) {
            jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found after pre-update`));
            return;
        }

        try {
            stateMachine.validate(freshSwap, newStatus as SwapStatus);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Invalid transition';
            jsonResponse(res, 409, fail('INVALID_TRANSITION', msg));
            return;
        }

        // Apply the status change
        const fromState = freshSwap.status;
        const updated = storage.updateSwap(
            swapId,
            { status: newStatus as SwapStatus } as IUpdateSwapParams,
            fromState,
            `Admin state change: ${fromState} → ${newStatus}`,
        );
        stateMachine.notifyTransition(updated, fromState, newStatus as SwapStatus);
        wsServer.broadcastSwapUpdate(updated);

        jsonResponse(res, 200, success({ swap: sanitizeSwapForApi(updated) }));
        return;
    }

    // No status change — just apply field updates
    if (Object.keys(updateParams).length === 0) {
        jsonResponse(res, 400, fail('VALIDATION', 'No valid update fields provided'));
        return;
    }

    const updated = storage.updateSwap(swapId, updateParams as IUpdateSwapParams);
    wsServer.broadcastSwapUpdate(updated);
    jsonResponse(res, 200, success({ swap: sanitizeSwapForApi(updated) }));
}

// ---------------------------------------------------------------------------
// Hex conversion helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        const hi = hex.charCodeAt(i * 2);
        const lo = hex.charCodeAt(i * 2 + 1);
        bytes[i] = (hexCharToNibble(hi) << 4) | hexCharToNibble(lo);
    }
    return bytes;
}

function hexCharToNibble(c: number): number {
    // 0-9: 48-57, a-f: 97-102
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 97 && c <= 102) return c - 87;
    return 0;
}

function bytesToHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b !== undefined) {
            hex += b.toString(16).padStart(2, '0');
        }
    }
    return hex;
}
