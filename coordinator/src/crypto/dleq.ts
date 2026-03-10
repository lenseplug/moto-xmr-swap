/**
 * Bob key proof-of-knowledge verification for trustless swaps.
 *
 * Replaces the V1 DLEQ placeholder with a Schnorr proof-of-knowledge scheme.
 * Bob proves he knows the private scalar behind his submitted ed25519 public key
 * by signing a deterministic challenge derived from the swap ID.
 *
 * Protocol:
 *   challenge = SHA-256("bob-key-proof:" || swapId)
 *   Prover: k = random, R = k*G, e = SHA-256(R || P || challenge) mod l, s = (k + e*priv) mod l
 *   Proof = R (32 bytes) || s (32 bytes)
 *   Verifier: e = SHA-256(R || P || challenge) mod l, check s*G == R + e*P
 *
 * This prevents Bob from submitting a crafted public key that would give him
 * control of the shared Monero address (S = S_a + S_b).
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'node:crypto';

/** Ed25519 curve order (l). */
const ED25519_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

/** Proof length: R (32 bytes) + s (32 bytes) = 64 bytes. */
const PROOF_LENGTH = 64;

/**
 * Computes the deterministic challenge for a swap.
 * challenge = SHA-256("bob-key-proof:" || swapId)
 */
function computeChallenge(swapId: string): Uint8Array {
    const hash = createHash('sha256');
    hash.update('bob-key-proof:');
    hash.update(swapId);
    return new Uint8Array(hash.digest());
}

/**
 * Computes the Fiat-Shamir hash for the Schnorr proof.
 * e = SHA-256(R || bobPub || challenge) interpreted as a scalar mod l.
 */
function computeFiatShamirHash(
    R: Uint8Array,
    bobPub: Uint8Array,
    challenge: Uint8Array,
): bigint {
    const hash = createHash('sha256');
    hash.update(R);
    hash.update(bobPub);
    hash.update(challenge);
    const digest = new Uint8Array(hash.digest());
    return bytesToScalar(digest) % ED25519_ORDER;
}

/**
 * Verifies Bob's proof-of-knowledge of his ed25519 private key.
 *
 * @param bobPub - Bob's ed25519 public key (32 bytes).
 * @param proof - The Schnorr proof (64 bytes: R || s).
 * @param swapId - The swap identifier (used to derive the challenge).
 * @returns true if Bob proved knowledge of the private key behind bobPub.
 */
export function verifyBobKeyProof(
    bobPub: Uint8Array,
    proof: Uint8Array,
    swapId: string,
): boolean {
    if (proof.length !== PROOF_LENGTH) {
        console.warn(`[KeyProof] Invalid proof length: ${proof.length} (expected ${PROOF_LENGTH})`);
        return false;
    }

    try {
        // Parse proof components
        const R_bytes = proof.subarray(0, 32);
        const s_bytes = proof.subarray(32, 64);

        // Decode points and scalar
        const R = ed25519.Point.fromBytes(R_bytes);
        const P = ed25519.Point.fromBytes(bobPub);
        const s = bytesToScalar(s_bytes);

        // Reject zero scalar (invalid proof)
        if (s === 0n || s >= ED25519_ORDER) {
            console.warn('[KeyProof] Invalid scalar in proof');
            return false;
        }

        // Compute challenge and Fiat-Shamir hash
        const challenge = computeChallenge(swapId);
        const e = computeFiatShamirHash(R_bytes, bobPub, challenge);

        // Verify: s*G == R + e*P
        const sG = ed25519.Point.BASE.multiply(s);
        const eP = P.multiply(e);
        const RpluseP = R.add(eP);

        return sG.equals(RpluseP);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[KeyProof] Verification failed: ${msg}`);
        return false;
    }
}

/**
 * @deprecated Use verifyBobKeyProof instead. DLEQ is no longer used.
 */
export function verifyCrossCurveDleq(
    _ed25519Point: Uint8Array,
    _secp256k1Point: Uint8Array,
    _proof: Uint8Array,
): boolean {
    console.warn('[DLEQ] verifyCrossCurveDleq is deprecated. Use verifyBobKeyProof instead.');
    return false;
}

/**
 * @deprecated Use the frontend signBobKeyProof instead.
 */
export function generateCrossCurveDleqProof(
    _scalar: Uint8Array,
    _ed25519Point: Uint8Array,
    _secp256k1Point: Uint8Array,
): Uint8Array {
    console.warn('[DLEQ] generateCrossCurveDleqProof is deprecated.');
    return new Uint8Array(0);
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
