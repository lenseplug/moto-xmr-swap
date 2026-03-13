/**
 * Route handlers for token management REST API endpoints.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { type IApiError, type IApiResponse, type ITokenRecord } from '../types.js';
import { StorageService } from '../storage.js';

/** Admin API key for protected endpoints. */
const ADMIN_API_KEY = process.env['ADMIN_API_KEY'] ?? '';

const MAX_BODY_BYTES = 65536;

/** Returns a structured success response. */
function success<T>(data: T): IApiResponse<T> {
    return { success: true, data, error: null };
}

/** Returns a structured error response. */
function fail(code: string, message: string, retryable = false): IApiResponse<never> {
    const error: IApiError = { code, message, retryable };
    return { success: false, data: null, error };
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

/**
 * Checks if the request has a valid admin API key via X-Admin-Key header.
 * Uses constant-time comparison to prevent timing attacks.
 */
function isTokenAdminAuthorized(req: IncomingMessage): boolean {
    if (ADMIN_API_KEY.length === 0) return false;
    const provided = req.headers['x-admin-key'];
    if (typeof provided !== 'string') return false;
    if (provided.length !== ADMIN_API_KEY.length) return false;
    let result = 0;
    for (let i = 0; i < provided.length; i++) {
        result |= provided.charCodeAt(i) ^ ADMIN_API_KEY.charCodeAt(i);
    }
    return result === 0;
}

/**
 * Handler: GET /api/tokens
 * Returns all active tokens. No authentication required.
 */
export function handleGetTokens(
    _req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
): void {
    const tokens = storage.getTokens();
    jsonResponse(res, 200, success<ITokenRecord[]>(tokens));
}

/**
 * Handler: POST /api/tokens
 * Adds a new supported token. Requires X-Admin-Key header.
 * Body: { address, symbol, name, decimals?, logo_url? }
 */
export async function handleAddToken(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
): Promise<void> {
    if (!isTokenAdminAuthorized(req)) {
        jsonResponse(res, 401, fail('UNAUTHORIZED', 'Valid X-Admin-Key header required'));
        return;
    }

    let address: string;
    let symbol: string;
    let name: string;
    let decimals = 18;
    let logoUrl: string | null = null;

    try {
        const parsed = await readBody(req);
        if (typeof parsed !== 'object' || parsed === null) {
            jsonResponse(res, 400, fail('VALIDATION', 'Request body must be a JSON object'));
            return;
        }
        const candidate = parsed as Record<string, unknown>;

        if (typeof candidate['address'] !== 'string' || candidate['address'].trim().length === 0) {
            jsonResponse(res, 400, fail('VALIDATION', 'address (string) is required'));
            return;
        }
        if (typeof candidate['symbol'] !== 'string' || candidate['symbol'].trim().length === 0) {
            jsonResponse(res, 400, fail('VALIDATION', 'symbol (string) is required'));
            return;
        }
        if (typeof candidate['name'] !== 'string' || candidate['name'].trim().length === 0) {
            jsonResponse(res, 400, fail('VALIDATION', 'name (string) is required'));
            return;
        }

        address = candidate['address'].trim();
        symbol = candidate['symbol'].trim().toUpperCase();
        name = candidate['name'].trim();

        if (typeof candidate['decimals'] === 'number' && Number.isInteger(candidate['decimals']) && candidate['decimals'] >= 0) {
            decimals = candidate['decimals'];
        }
        if (typeof candidate['logo_url'] === 'string' && candidate['logo_url'].trim().length > 0) {
            logoUrl = candidate['logo_url'].trim();
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid request';
        jsonResponse(res, 400, fail('INVALID_BODY', msg));
        return;
    }

    // Check for duplicate
    const existing = storage.getToken(address);
    if (existing) {
        jsonResponse(res, 409, fail('CONFLICT', `Token with address ${address} already exists`));
        return;
    }

    try {
        const token = storage.addToken(address, symbol, name, decimals, logoUrl);
        jsonResponse(res, 201, success<ITokenRecord>(token));
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Storage error';
        jsonResponse(res, 500, fail('STORAGE_ERROR', msg, true));
    }
}

/**
 * Handler: DELETE /api/tokens/:address
 * Deactivates a token. Requires X-Admin-Key header.
 */
export function handleDeactivateToken(
    req: IncomingMessage,
    res: ServerResponse,
    storage: StorageService,
    address: string,
): void {
    if (!isTokenAdminAuthorized(req)) {
        jsonResponse(res, 401, fail('UNAUTHORIZED', 'Valid X-Admin-Key header required'));
        return;
    }

    const deactivated = storage.deactivateToken(address);
    if (!deactivated) {
        jsonResponse(res, 404, fail('NOT_FOUND', `Token with address ${address} not found`));
        return;
    }

    jsonResponse(res, 200, success({ deactivated: true, address }));
}
