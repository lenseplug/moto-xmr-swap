/**
 * Hash-lock generation utilities for atomic swaps.
 * Uses SHA-256 (Bitcoin's hash function, not Keccak-256).
 * All operations use Uint8Array — never Buffer.
 */
import type { LocalSwapSecret } from '../types/swap';

const LOCAL_SECRETS_KEY = 'moto_xmr_swap_secrets';

/**
 * Generates a cryptographically random 32-byte secret and computes its SHA-256 hash.
 * The hash becomes the hashLock stored on-chain.
 * The secret is stored locally and revealed during the claim step.
 *
 * @returns The secret (hex) and hashLock (bigint for contract call)
 */
export async function generateSecretAndHashLock(): Promise<{
    readonly secret: string;
    readonly hashLock: bigint;
    readonly hashLockHex: string;
}> {
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secretHex = uint8ArrayToHex(secretBytes);

    const hashBytes = await crypto.subtle.digest('SHA-256', secretBytes);
    const hashHex = uint8ArrayToHex(new Uint8Array(hashBytes));
    const hashLock = BigInt('0x' + hashHex);

    return { secret: secretHex, hashLock, hashLockHex: hashHex };
}

/**
 * Converts a Uint8Array to a lowercase hex string.
 *
 * @param bytes - Input bytes
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Converts a hex string to Uint8Array.
 *
 * @param hex - Hex string (with or without 0x prefix)
 */
export function hexToUint8Array(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Computes SHA-256 of a hex-encoded preimage and returns the hash as a bigint.
 *
 * @param secretHex - The secret preimage as a hex string
 */
export async function hashSecret(secretHex: string): Promise<bigint> {
    const secretBytes = hexToUint8Array(secretHex);
    const hashBytes = await crypto.subtle.digest('SHA-256', secretBytes.buffer as ArrayBuffer);
    const hashHex = uint8ArrayToHex(new Uint8Array(hashBytes));
    return BigInt('0x' + hashHex);
}

/**
 * Converts a secret hex string to a bigint for use in the claim() call.
 *
 * @param secretHex - The secret as a 64-char hex string
 */
export function secretHexToBigint(secretHex: string): bigint {
    const clean = secretHex.startsWith('0x') ? secretHex.slice(2) : secretHex;
    return BigInt('0x' + clean);
}

/**
 * Persists a swap secret to localStorage so the user can claim later.
 *
 * @param swapId - The swap ID (decimal string)
 * @param secret - The secret preimage hex
 * @param hashLock - The hash lock hex
 */
export function saveLocalSwapSecret(swapId: string, secret: string, hashLock: string): void {
    const secrets = loadLocalSwapSecrets();
    const entry: LocalSwapSecret = {
        swapId,
        secret,
        hashLock,
        createdAt: Date.now(),
    };
    secrets.push(entry);
    localStorage.setItem(LOCAL_SECRETS_KEY, JSON.stringify(secrets));
}

/**
 * Loads all locally stored swap secrets.
 */
export function loadLocalSwapSecrets(): LocalSwapSecret[] {
    try {
        const raw = localStorage.getItem(LOCAL_SECRETS_KEY);
        if (!raw) return [];
        return JSON.parse(raw) as LocalSwapSecret[];
    } catch {
        return [];
    }
}

/**
 * Retrieves the secret for a specific swap ID.
 *
 * @param swapId - The swap ID (decimal string)
 */
export function getLocalSwapSecret(swapId: string): LocalSwapSecret | null {
    const secrets = loadLocalSwapSecrets();
    return secrets.find((s) => s.swapId === swapId) ?? null;
}
