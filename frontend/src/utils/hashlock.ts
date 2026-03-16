/**
 * Hash-lock generation utilities for atomic swaps.
 * Uses SHA-256 (Bitcoin's hash function, not Keccak-256).
 * All operations use Uint8Array — never Buffer.
 */
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Converts a Uint8Array to a lowercase hex string.
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Converts a hex string to Uint8Array.
 */
export function hexToUint8Array(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length === 0 || clean.length % 2 !== 0) {
        throw new Error(`hexToUint8Array: invalid hex length ${clean.length} (must be even and non-zero)`);
    }
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
        throw new Error('hexToUint8Array: contains non-hex characters');
    }
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Computes SHA-256 of a hex-encoded preimage and returns the hash as a bigint.
 */
export async function hashSecret(secretHex: string): Promise<bigint> {
    const secretBytes = hexToUint8Array(secretHex);
    const hashHex = uint8ArrayToHex(sha256(secretBytes));
    return BigInt('0x' + hashHex);
}

/**
 * Converts a secret hex string to a bigint for use in the claim() call.
 */
export function secretHexToBigint(secretHex: string): bigint {
    const clean = secretHex.startsWith('0x') ? secretHex.slice(2) : secretHex;
    return BigInt('0x' + clean);
}
