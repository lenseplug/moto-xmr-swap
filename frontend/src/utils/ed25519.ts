/**
 * Browser-compatible ed25519 key operations for Monero split-key swaps.
 *
 * Uses @noble/curves for all elliptic curve math (available transitively via @btc-vision/bitcoin).
 * Uses crypto.getRandomValues() for secure randomness (Web Crypto API).
 *
 * IMPORTANT: Monero keys use direct scalar multiplication (pub = scalar * G),
 * NOT standard ed25519 which hashes the seed first. This is required for
 * additive key homomorphism: (s_a + s_b)*G == S_a*G + S_b*G.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** Ed25519 curve order (l). */
const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Generates a random ed25519 key pair suitable for Monero key splitting.
 *
 * Unlike standard ed25519, the private key is a raw scalar (reduced mod l),
 * and the public key is computed as scalar * G without hashing.
 *
 * @returns Object with privateKey and publicKey as Uint8Array (32 bytes each).
 */
export function generateEd25519KeyPair(): {
    readonly privateKey: Uint8Array;
    readonly publicKey: Uint8Array;
} {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const scalar = bytesToScalar(raw) % ED25519_ORDER;
    const privateKey = scalarToBytes(scalar);
    const publicKey = scalarMultBase(scalar);
    return { privateKey, publicKey };
}

/**
 * Derives the ed25519 public key from a private scalar (Monero-style).
 * Uses direct scalar multiplication: pub = scalar * G.
 */
export function ed25519PublicFromPrivate(privateKey: Uint8Array): Uint8Array {
    const scalar = bytesToScalar(privateKey) % ED25519_ORDER;
    return scalarMultBase(scalar);
}

/**
 * Computes scalar * G on ed25519, returning the compressed point (32 bytes).
 */
function scalarMultBase(scalar: bigint): Uint8Array {
    const point = ed25519.Point.BASE.multiply(scalar);
    return point.toBytes();
}

/**
 * Converts a 32-byte little-endian Uint8Array to a BigInt scalar.
 */
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

/**
 * Converts a BigInt scalar to a 32-byte little-endian Uint8Array.
 */
function scalarToBytes(scalar: bigint): Uint8Array {
    const bytes = new Uint8Array(32);
    let remaining = scalar;
    for (let i = 0; i < 32; i++) {
        bytes[i] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    return bytes;
}

/**
 * Generates a Schnorr proof-of-knowledge for Bob's ed25519 key.
 * Proves Bob knows the private scalar behind his public key, preventing
 * crafted-key attacks on the shared Monero address.
 *
 * Protocol:
 *   challenge = SHA-256("bob-key-proof:" || swapId)
 *   k = random, R = k*G
 *   e = SHA-256(R || bobPub || challenge) mod l
 *   s = (k + e * bobPriv) mod l
 *   proof = R (32 bytes) || s (32 bytes)
 *
 * @param bobPrivateKey - Bob's ed25519 private scalar (32 bytes).
 * @param bobPublicKey - Bob's ed25519 public key (32 bytes).
 * @param swapId - The swap ID string.
 * @returns The proof as Uint8Array (64 bytes: R || s).
 */
export async function signBobKeyProof(
    bobPrivateKey: Uint8Array,
    bobPublicKey: Uint8Array,
    swapId: string,
): Promise<Uint8Array> {
    // 1. Compute deterministic challenge
    const challengeData = new TextEncoder().encode('bob-key-proof:' + swapId);
    const challenge = sha256(challengeData);

    // 2. Generate random nonce k
    const kRaw = crypto.getRandomValues(new Uint8Array(32));
    const k = bytesToScalar(kRaw) % ED25519_ORDER;

    // 3. Compute R = k * G
    const R = ed25519.Point.BASE.multiply(k);
    const R_bytes = R.toBytes();

    // 4. Compute e = SHA-256(R || bobPub || challenge) mod l
    const hashInput = new Uint8Array(32 + 32 + 32);
    hashInput.set(R_bytes, 0);
    hashInput.set(bobPublicKey, 32);
    hashInput.set(challenge, 64);
    const e = bytesToScalar(sha256(hashInput)) % ED25519_ORDER;

    // 5. Compute s = (k + e * bobPriv) mod l
    const x = bytesToScalar(bobPrivateKey) % ED25519_ORDER;
    const s = (k + e * x) % ED25519_ORDER;
    const s_bytes = scalarToBytes(s);

    // 6. Proof = R || s
    const proof = new Uint8Array(64);
    proof.set(R_bytes, 0);
    proof.set(s_bytes, 32);

    return proof;
}
