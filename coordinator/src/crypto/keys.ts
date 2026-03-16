/**
 * Ed25519 key operations for Monero split-key swaps.
 *
 * Uses @noble/curves for all elliptic curve math — an audited, pure-JS library.
 * This module handles:
 * - Ed25519 key pair generation (Monero-style: raw scalar, NOT hashed seed)
 * - Point addition (for computing shared public keys)
 * - Scalar addition (for reconstructing spend keys)
 * - Monero address encoding
 *
 * IMPORTANT: Monero keys are NOT standard ed25519 signature keys.
 * Standard ed25519: pub = H(seed)[0:32]_clamped * G  (seed is hashed first)
 * Monero:           pub = scalar * G                  (direct scalar mult)
 *
 * For key splitting to work, we need:
 *   S_a + S_b = (s_a + s_b) * G
 * This only holds if S_x = s_x * G (direct), not S_x = H(s_x) * G.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { randomBytes } from 'node:crypto';
import type { IEd25519KeyPair, ISharedMoneroAddress, MoneroNetwork } from './types.js';

/** Ed25519 curve order (l). Exported for shared use across crypto modules. */
export const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Generates a random ed25519 key pair suitable for Monero key splitting.
 *
 * Unlike standard ed25519, the private key is a raw scalar (reduced mod l),
 * and the public key is computed as scalar * G without hashing.
 * This ensures additive key homomorphism: s_a*G + s_b*G = (s_a + s_b)*G.
 */
export function generateEd25519KeyPair(): IEd25519KeyPair {
    // Generate 32 random bytes and reduce mod l (Monero sc_reduce32 equivalent).
    // Retry if scalar is zero after reduction (probability ~2^-252, but must be defended).
    let scalar: bigint;
    let raw: Uint8Array;
    do {
        raw = randomBytes(32);
        scalar = bytesToScalar(raw) % ED25519_ORDER;
    } while (scalar === 0n);

    const privateKey = scalarToBytes(scalar);

    // Compute public key as scalar * G (direct, no hashing)
    const publicKey = scalarMultBase(scalar);

    return { privateKey, publicKey };
}

/**
 * Derives the ed25519 public key from a private scalar (Monero-style).
 * Uses direct scalar multiplication: pub = scalar * G.
 * NOT the standard ed25519 derivation which hashes the seed.
 */
export function ed25519PublicFromPrivate(privateKey: Uint8Array): Uint8Array {
    const scalar = bytesToScalar(privateKey) % ED25519_ORDER;
    return scalarMultBase(scalar);
}

/**
 * Adds two ed25519 public keys (point addition).
 * Used to compute the shared Monero spend/view public key:
 *   S = S_a + S_b
 *   V = V_a + V_b
 *
 * @param pointA - First public key (32 bytes, compressed ed25519 point).
 * @param pointB - Second public key (32 bytes, compressed ed25519 point).
 * @returns The sum point (32 bytes, compressed).
 */
export function addEd25519Points(pointA: Uint8Array, pointB: Uint8Array): Uint8Array {
    const a = ed25519.Point.fromBytes(pointA);
    const b = ed25519.Point.fromBytes(pointB);
    const sum = a.add(b);
    return sum.toBytes();
}

/**
 * Adds two ed25519 private keys (scalar addition mod l).
 * Used to reconstruct the full Monero spend key:
 *   s = s_a + s_b (mod l)
 *
 * @param scalarA - First private key (32 bytes, little-endian scalar).
 * @param scalarB - Second private key (32 bytes, little-endian scalar).
 * @returns The sum scalar (32 bytes, little-endian).
 */
export function addEd25519Scalars(scalarA: Uint8Array, scalarB: Uint8Array): Uint8Array {
    const a = bytesToScalar(scalarA);
    const b = bytesToScalar(scalarB);
    const sum = (a + b) % ED25519_ORDER;
    return scalarToBytes(sum);
}

/**
 * Validates that a view key scalar produces a non-degenerate ed25519 point.
 * Returns null if valid, or an error string if invalid.
 *
 * Checks:
 * 1. Scalar is not zero (mod l)
 * 2. Resulting point is not the identity
 * 3. Resulting point is not a small-order torsion point (8*P != identity)
 *
 * This prevents a malicious participant from submitting a view key that
 * makes the shared address unscannable or predictable.
 */
export function validateViewKeyScalar(viewKeyBytes: Uint8Array): string | null {
    const scalar = bytesToScalar(viewKeyBytes) % ED25519_ORDER;
    if (scalar === 0n) {
        return 'View key scalar is zero (mod l)';
    }
    const point = scalarMultBase(scalar);
    const p = ed25519.Point.fromBytes(point);
    if (p.equals(ed25519.Point.ZERO)) {
        return 'View key produces identity point';
    }
    if (p.multiply(8n).equals(ed25519.Point.ZERO)) {
        return 'View key produces small-order torsion point';
    }
    return null;
}

/**
 * Computes a shared Monero address from Alice's and Bob's key shares.
 *
 * The shared address is a standard Monero address where:
 * - Public spend key = S_a + S_b (neither party can spend alone)
 * - Public view key = v_combined * G where v_combined = v_a + v_b
 *
 * @param aliceSpendPub - Alice's ed25519 public spend key (32 bytes).
 * @param bobSpendPub - Bob's ed25519 public spend key (32 bytes).
 * @param aliceViewPriv - Alice's ed25519 private view key (32 bytes, raw scalar).
 * @param bobViewPriv - Bob's ed25519 private view key (32 bytes, raw scalar).
 * @param network - Monero network ('mainnet' or 'stagenet').
 * @returns The shared Monero address with its component keys.
 */
export function computeSharedMoneroAddress(
    aliceSpendPub: Uint8Array,
    bobSpendPub: Uint8Array,
    aliceViewPriv: Uint8Array,
    bobViewPriv: Uint8Array,
    network: MoneroNetwork,
): ISharedMoneroAddress {
    // Compute shared public spend key: S = S_a + S_b
    const publicSpendKey = addEd25519Points(aliceSpendPub, bobSpendPub);

    // Reject identity and small-order torsion points — would produce an unspendable Monero address.
    // A malicious Bob could set S_b = -S_a to force S = identity, permanently locking any XMR sent there.
    // Cofactor check: 8 * S == identity means the combined key is in the small-order subgroup.
    const spendPoint = ed25519.Point.fromBytes(publicSpendKey);
    if (spendPoint.equals(ed25519.Point.ZERO) || spendPoint.multiply(8n).equals(ed25519.Point.ZERO)) {
        throw new Error('Combined spend key is a small-order torsion point — keys cancel or produce unspendable address');
    }

    // Compute shared view key: v = v_a + v_b, V = v * G (direct scalar mult)
    const combinedViewScalar = addEd25519Scalars(aliceViewPriv, bobViewPriv);

    // Reject zero combined view scalar — would make the address unscannable (cannot detect incoming txs).
    // Check both the scalar value (all bytes zero) and the resulting point (identity).
    const viewScalarIsZero = combinedViewScalar.every((b) => b === 0);
    if (viewScalarIsZero) {
        throw new Error('Combined view key scalar is zero — view keys are negations of each other');
    }
    const publicViewKey = ed25519PublicFromPrivate(combinedViewScalar);

    // Encode as a standard Monero address
    const address = encodeMoneroAddress(publicSpendKey, publicViewKey, network);

    return { address, publicSpendKey, publicViewKey, privateViewKey: combinedViewScalar };
}

/**
 * Validates that a combined scalar (from addEd25519Scalars) produces a safe,
 * spendable ed25519 public key. Rejects zero, identity, and small-order points.
 *
 * @param scalarBytes - 32-byte combined scalar (little-endian).
 * @returns null if safe, or a string error describing the problem.
 */
export function validateCombinedKey(scalarBytes: Uint8Array): string | null {
    const scalar = bytesToScalar(scalarBytes) % ED25519_ORDER;
    if (scalar === 0n) {
        return 'Combined scalar is zero — keys cancelled out';
    }
    try {
        const point = scalarMultBase(scalar);
        const p = ed25519.Point.fromBytes(point);
        if (p.equals(ed25519.Point.ZERO)) {
            return 'Combined key produces identity point';
        }
        if (p.multiply(8n).equals(ed25519.Point.ZERO)) {
            return 'Combined key produces small-order torsion point';
        }
    } catch {
        return 'Combined key produces invalid curve point';
    }
    return null;
}

// ---------------------------------------------------------------------------
// Direct scalar multiplication (Monero-style, no seed hashing)
// ---------------------------------------------------------------------------

/**
 * Computes scalar * G on ed25519, returning the compressed point (32 bytes).
 * This is the Monero-style key derivation: direct scalar multiplication
 * without the SHA-512 seed hashing used in standard ed25519 signatures.
 */
function scalarMultBase(scalar: bigint): Uint8Array {
    const point = ed25519.Point.BASE.multiply(scalar);
    return point.toBytes();
}

// ---------------------------------------------------------------------------
// Monero address encoding
// ---------------------------------------------------------------------------

/** Network byte prefixes for Monero standard addresses. */
const MONERO_NETWORK_BYTE: Record<MoneroNetwork, number> = {
    mainnet: 18,   // '4' prefix
    stagenet: 24,  // '5' prefix
};

/**
 * Encodes a Monero standard address from public spend and view keys.
 * Format: [network_byte (1)] [spend_key (32)] [view_key (32)] [checksum (4)]
 * Then Base58-encode the 69-byte payload.
 */
function encodeMoneroAddress(
    publicSpendKey: Uint8Array,
    publicViewKey: Uint8Array,
    network: MoneroNetwork,
): string {
    const networkByte = MONERO_NETWORK_BYTE[network];
    if (networkByte === undefined) {
        throw new Error(`Unknown Monero network: ${network}`);
    }

    // Build payload: network_byte + spend_key + view_key
    const payload = new Uint8Array(65);
    payload[0] = networkByte;
    payload.set(publicSpendKey, 1);
    payload.set(publicViewKey, 33);

    // Compute Keccak-256 checksum (first 4 bytes)
    const hash = keccak256(payload);
    const checksum = hash.slice(0, 4);

    // Full data: payload + checksum = 69 bytes
    const fullData = new Uint8Array(69);
    fullData.set(payload);
    fullData.set(checksum, 65);

    // Monero uses a custom Base58 encoding (8-byte blocks)
    return moneroBase58Encode(fullData);
}

// ---------------------------------------------------------------------------
// Keccak-256 (Monero uses Keccak, not SHA-3)
// ---------------------------------------------------------------------------

/**
 * Keccak-256 hash (NOT SHA-3-256 — Monero uses the original Keccak submission).
 * SHA-3-256 adds NIST padding (0x06) while Keccak-256 uses original padding (0x01).
 * We use @noble/hashes which provides the correct pre-NIST Keccak.
 */
function keccak256(data: Uint8Array): Uint8Array {
    return keccak_256(data);
}

// ---------------------------------------------------------------------------
// Monero Base58 encoding
// ---------------------------------------------------------------------------

const MONERO_BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MONERO_BASE58_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11] as const;
const MONERO_FULL_BLOCK_SIZE = 8;
const MONERO_FULL_ENCODED_BLOCK_SIZE = 11;

/**
 * Monero-specific Base58 encoding.
 * Unlike standard Base58, Monero encodes in 8-byte blocks to ensure
 * a fixed-length output (no leading-zero compression).
 */
function moneroBase58Encode(data: Uint8Array): string {
    let result = '';
    const fullBlocks = Math.floor(data.length / MONERO_FULL_BLOCK_SIZE);
    const lastBlockSize = data.length % MONERO_FULL_BLOCK_SIZE;

    for (let i = 0; i < fullBlocks; i++) {
        const block = data.slice(i * MONERO_FULL_BLOCK_SIZE, (i + 1) * MONERO_FULL_BLOCK_SIZE);
        result += encodeBlock(block, MONERO_FULL_ENCODED_BLOCK_SIZE);
    }

    if (lastBlockSize > 0) {
        const lastBlock = data.slice(fullBlocks * MONERO_FULL_BLOCK_SIZE);
        const encodedSize = MONERO_BASE58_BLOCK_SIZES[lastBlockSize];
        if (encodedSize === undefined) {
            throw new Error(`Invalid last block size: ${lastBlockSize}`);
        }
        result += encodeBlock(lastBlock, encodedSize);
    }

    return result;
}

function encodeBlock(block: Uint8Array, encodedSize: number): string {
    // Convert block to a big integer
    let num = 0n;
    for (let i = 0; i < block.length; i++) {
        const byte = block[i];
        if (byte !== undefined) {
            num = num * 256n + BigInt(byte);
        }
    }

    // Convert to base58
    const chars: string[] = [];
    for (let i = 0; i < encodedSize; i++) {
        const remainder = num % 58n;
        num = num / 58n;
        const char = MONERO_BASE58_ALPHABET[Number(remainder)];
        if (char !== undefined) {
            chars.push(char);
        }
    }

    // Reverse (least significant digit was added first)
    return chars.reverse().join('');
}

// ---------------------------------------------------------------------------
// Monero Base58 decoding
// ---------------------------------------------------------------------------

/**
 * Monero-specific Base58 decoding.
 * Decodes in fixed-size blocks (reverse of moneroBase58Encode).
 * Returns the raw byte payload or null if the string is invalid Base58.
 */
export function moneroBase58Decode(encoded: string): Uint8Array | null {
    // Standard address: 95 chars → 69 bytes (8 full blocks of 11 chars + 7-char tail)
    // Integrated address: 106 chars → 77 bytes (9 full blocks of 11 chars + 7-char tail)
    const fullBlocks = Math.floor(encoded.length / MONERO_FULL_ENCODED_BLOCK_SIZE);
    const lastEncodedSize = encoded.length % MONERO_FULL_ENCODED_BLOCK_SIZE;

    // Find the raw byte count for the last block
    let lastRawSize = 0;
    if (lastEncodedSize > 0) {
        const idx = MONERO_BASE58_BLOCK_SIZES.indexOf(lastEncodedSize as 0 | 2 | 3 | 5 | 6 | 7 | 9 | 10 | 11);
        if (idx < 0) return null; // invalid tail length
        lastRawSize = idx;
    }

    const totalBytes = fullBlocks * MONERO_FULL_BLOCK_SIZE + lastRawSize;
    const result = new Uint8Array(totalBytes);

    let offset = 0;
    for (let i = 0; i < fullBlocks; i++) {
        const chunk = encoded.slice(i * MONERO_FULL_ENCODED_BLOCK_SIZE, (i + 1) * MONERO_FULL_ENCODED_BLOCK_SIZE);
        const decoded = decodeBlock(chunk, MONERO_FULL_BLOCK_SIZE);
        if (decoded === null) return null;
        result.set(decoded, offset);
        offset += MONERO_FULL_BLOCK_SIZE;
    }

    if (lastEncodedSize > 0) {
        const chunk = encoded.slice(fullBlocks * MONERO_FULL_ENCODED_BLOCK_SIZE);
        const decoded = decodeBlock(chunk, lastRawSize);
        if (decoded === null) return null;
        result.set(decoded, offset);
    }

    return result;
}

function decodeBlock(chunk: string, rawSize: number): Uint8Array | null {
    let num = 0n;
    for (let i = 0; i < chunk.length; i++) {
        const idx = MONERO_BASE58_ALPHABET.indexOf(chunk[i] as string);
        if (idx < 0) return null; // invalid character
        num = num * 58n + BigInt(idx);
    }

    const bytes = new Uint8Array(rawSize);
    for (let i = rawSize - 1; i >= 0; i--) {
        bytes[i] = Number(num & 0xffn);
        num >>= 8n;
    }

    // If num != 0 after extraction, the encoded value overflows the block size
    if (num !== 0n) return null;
    return bytes;
}

/**
 * Verifies a Monero address checksum (Keccak-256, first 4 bytes).
 * Returns null if valid, error string if invalid.
 */
export function verifyMoneroAddressChecksum(address: string): string | null {
    const raw = moneroBase58Decode(address);
    if (raw === null) {
        return 'Failed to Base58-decode address — contains invalid characters or invalid block structure';
    }

    if (raw.length < 5) {
        return `Decoded payload too short: ${raw.length} bytes (minimum 5)`;
    }

    // Split payload and checksum (last 4 bytes)
    const payload = raw.slice(0, raw.length - 4);
    const storedChecksum = raw.slice(raw.length - 4);

    // Compute expected checksum: first 4 bytes of Keccak-256(payload)
    const hash = keccak256(payload);
    const expectedChecksum = hash.slice(0, 4);

    for (let i = 0; i < 4; i++) {
        if (storedChecksum[i] !== expectedChecksum[i]) {
            return 'Address checksum mismatch — the address is corrupted or contains a typo';
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Scalar <-> bytes helpers
// ---------------------------------------------------------------------------

/** Converts a 32-byte little-endian Uint8Array to a BigInt scalar. */
function bytesToScalar(bytes: Uint8Array): bigint {
    let result = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        const byte = bytes[i];
        if (byte !== undefined) {
            result = result * 256n + BigInt(byte);
        }
    }
    return result;
}

/** Converts a BigInt scalar to a 32-byte little-endian Uint8Array. */
function scalarToBytes(scalar: bigint): Uint8Array {
    const bytes = new Uint8Array(32);
    let remaining = scalar;
    for (let i = 0; i < 32; i++) {
        bytes[i] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    return bytes;
}
