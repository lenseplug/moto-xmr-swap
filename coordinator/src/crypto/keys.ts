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

/** Ed25519 curve order (l). */
const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Generates a random ed25519 key pair suitable for Monero key splitting.
 *
 * Unlike standard ed25519, the private key is a raw scalar (reduced mod l),
 * and the public key is computed as scalar * G without hashing.
 * This ensures additive key homomorphism: s_a*G + s_b*G = (s_a + s_b)*G.
 */
export function generateEd25519KeyPair(): IEd25519KeyPair {
    // Generate 32 random bytes and reduce mod l (Monero sc_reduce32 equivalent)
    const raw = randomBytes(32);
    const scalar = bytesToScalar(raw) % ED25519_ORDER;
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

    // Compute shared view key: v = v_a + v_b, V = v * G (direct scalar mult)
    const combinedViewScalar = addEd25519Scalars(aliceViewPriv, bobViewPriv);
    const publicViewKey = ed25519PublicFromPrivate(combinedViewScalar);

    // Encode as a standard Monero address
    const address = encodeMoneroAddress(publicSpendKey, publicViewKey, network);

    return { address, publicSpendKey, publicViewKey };
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
