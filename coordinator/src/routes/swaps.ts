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
} from '../types.js';
import { StorageService } from '../storage.js';

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
    jsonResponse(res, 200, success({ swaps, page, limit }));
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
    jsonResponse(res, 200, success({ swap, history }));
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

    if (swap.status !== SwapStatus.OPEN) {
        jsonResponse(res, 409, fail('INVALID_STATE', `Swap is not OPEN (current: ${swap.status})`));
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

    // Record the take notification only — the on-chain watcher is the authoritative
    // source that will set the counterparty address and transition the swap to TAKEN
    // once it observes the transaction on-chain.
    jsonResponse(res, 200, success({ swap, opnetTxId: body.opnetTxId.trim() }));
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
        body = {
            swap_id: candidate['swap_id'],
            hash_lock: candidate['hash_lock'],
            refund_block: candidate['refund_block'],
            moto_amount: candidate['moto_amount'],
            xmr_amount: candidate['xmr_amount'],
            xmr_address:
                typeof candidate['xmr_address'] === 'string' ? candidate['xmr_address'] : null,
            depositor: candidate['depositor'],
            opnet_create_tx:
                typeof candidate['opnet_create_tx'] === 'string'
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
