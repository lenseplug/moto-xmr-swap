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
    type ITakeSwapBody,
    SwapStatus,
    calculateXmrFee,
    calculateXmrTotal,
    safeParseAmount,
    MIN_XMR_AMOUNT_PICONERO,
} from '../types.js';
import { StorageService } from '../storage.js';
import { randomBytes } from 'node:crypto';
import { getFeeAddress, setFeeAddress, verifyPreimage } from '../monero-module.js';

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
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10)));
    return { page, limit };
}

/**
 * Strips sensitive fields (preimage) from a swap record before sending to clients.
 * The preimage is ONLY delivered via WebSocket, never via HTTP.
 */
function sanitizeSwapForApi(swap: ISwapRecord): Omit<ISwapRecord, 'preimage' | 'claim_token'> & { preimage: null; claim_token: null } {
    return { ...swap, preimage: null, claim_token: null };
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

    // Re-check claim_token after the await (TOCTOU guard):
    // Another concurrent request may have set it during readBody().
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
    const swap = storage.getSwap(swapId);
    if (!swap) {
        jsonResponse(res, 404, fail('NOT_FOUND', `Swap ${swapId} not found`));
        return;
    }

    // Only accept secrets for swaps that have been taken.
    // OPEN is rejected — storing the preimage before anyone takes the swap
    // increases exposure window if the database is compromised.
    // TAKEN: normal submission flow.
    // XMR_LOCKING/XMR_LOCKED: allow re-submission (preimage already stored — idempotent).
    const ACCEPT_SECRET_STATES = new Set([
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
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    // Validate format: 64 hex characters
    if (!/^[0-9a-f]{64}$/.test(secret)) {
        jsonResponse(res, 400, fail('VALIDATION', 'Secret must be exactly 64 hex characters'));
        return;
    }

    // Critical security check: SHA-256(secret) must match hash_lock
    if (!verifyPreimage(secret, swap.hash_lock)) {
        jsonResponse(
            res,
            400,
            fail('HASH_MISMATCH', 'SHA-256(secret) does not match the swap hash lock'),
        );
        return;
    }

    // Idempotent: if same preimage is already stored, return success
    if (swap.preimage !== null && swap.preimage.length > 0) {
        if (swap.preimage === secret) {
            jsonResponse(res, 200, success({ stored: true }));
            return;
        }
        // Different preimage for same swap — reject
        jsonResponse(res, 409, fail('ALREADY_SET', 'A different preimage is already stored for this swap'));
        return;
    }

    // Store the preimage
    storage.updateSwap(swapId, { preimage: secret });
    console.log(`[Routes] Secret stored for swap ${swapId}`);

    jsonResponse(res, 200, success({ stored: true }));
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
