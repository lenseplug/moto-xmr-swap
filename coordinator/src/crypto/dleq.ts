/**
 * Key proof verification for split-key swaps.
 *
 * Contains:
 * 1. Schnorr proof-of-knowledge (verifyBobKeyProof) — proves Bob knows his ed25519 scalar.
 * 2. Cross-curve DLEQ verification (verifyCrossCurveDleq) — proves the same scalar
 *    underlies keys on both ed25519 and secp256k1.
 *
 * DLEQ v2 proof format: c (32 bytes) || s (64 bytes big-endian) = 96 bytes.
 * Uses a single response scalar computed in the integers (not reduced mod either order).
 * Domain separator: 'moto-xmr-dleq-v2'
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createHash } from 'node:crypto';
import { ED25519_ORDER } from './keys.js';

/** Converts Uint8Array to hex string for @noble/curves fromHex(). */
function toHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

/** Secp256k1 curve order (n). */
const SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/** DLEQ v2 domain separator — must match the frontend. */
const DLEQ_DOMAIN = 'moto-xmr-dleq-v2';

/** Schnorr proof length: R (32 bytes) + s (32 bytes) = 64 bytes. */
const SCHNORR_PROOF_LENGTH = 64;

/** DLEQ v2 proof length: c (32) + s (64) = 96 bytes. */
const DLEQ_PROOF_LENGTH = 96;

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
    return bytesToScalarLE(digest) % ED25519_ORDER;
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
    if (proof.length !== SCHNORR_PROOF_LENGTH) {
        console.warn(`[KeyProof] Invalid proof length: ${proof.length} (expected ${SCHNORR_PROOF_LENGTH})`);
        return false;
    }

    try {
        // Parse proof components
        const R_bytes = proof.subarray(0, 32);
        const s_bytes = proof.subarray(32, 64);

        // Decode points and scalar
        const R = ed25519.Point.fromBytes(R_bytes);
        const P = ed25519.Point.fromBytes(bobPub);
        const s = bytesToScalarLE(s_bytes);

        // Reject small-order / torsion points — would allow trivially-forged proofs.
        // Ed25519 has cofactor 8, so there are 8 small-order points (including identity).
        // Cofactor check: 8 * P == identity means P is in the small-order subgroup.
        // Note: @noble/curves rejects multiply(L) for L >= curve.n, so we use
        // cofactor multiplication instead. This catches all 8 small-order points.
        if (P.equals(ed25519.Point.ZERO) || P.multiply(8n).equals(ed25519.Point.ZERO)) {
            console.warn('[KeyProof] Public key P is a small-order torsion point — rejecting');
            return false;
        }
        if (R.equals(ed25519.Point.ZERO) || R.multiply(8n).equals(ed25519.Point.ZERO)) {
            console.warn('[KeyProof] Nonce R is a small-order torsion point — rejecting');
            return false;
        }

        // Reject zero scalar (invalid proof)
        if (s === 0n || s >= ED25519_ORDER) {
            console.warn('[KeyProof] Invalid scalar in proof');
            return false;
        }

        // Compute challenge and Fiat-Shamir hash
        const challenge = computeChallenge(swapId);
        const e = computeFiatShamirHash(R_bytes, bobPub, challenge);

        // Reject zero challenge — degenerates proof to s*G = R (proves nothing about P)
        if (e === 0n) {
            console.warn('[KeyProof] Degenerate Fiat-Shamir hash (zero) — rejecting');
            return false;
        }

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

// ---------------------------------------------------------------------------
// Cross-curve DLEQ v2 verification (single response scalar)
// ---------------------------------------------------------------------------

/**
 * Computes the DLEQ challenge hash:
 * c = SHA-256(R_ed || R_sec || P_ed || P_sec || "moto-xmr-dleq-v2" || ":" || context)
 * The optional context binds the proof to a specific swap (prevents cross-swap replay).
 */
function computeDleqChallenge(
    rEd: Uint8Array,
    rSec: Uint8Array,
    pEd: Uint8Array,
    pSec: Uint8Array,
    context?: string,
): Uint8Array {
    const hash = createHash('sha256');
    hash.update(rEd);
    hash.update(rSec);
    hash.update(pEd);
    hash.update(pSec);
    hash.update(DLEQ_DOMAIN);
    if (context) {
        hash.update(':' + context);
    }
    return new Uint8Array(hash.digest());
}

/**
 * Verifies a cross-curve DLEQ proof (v2) that the same scalar underlies
 * both an ed25519 and a secp256k1 public key.
 *
 * v2 proof format: c (32 bytes) || s (64 bytes big-endian)
 *
 * The single response scalar `s` is reduced mod each curve's order for
 * independent verification on each curve. This binds both curves to the
 * same underlying scalar, unlike v1 which had independent per-curve responses.
 *
 * @param ed25519Point - The ed25519 public key (32 bytes compressed).
 * @param secp256k1Point - The secp256k1 public key (33 bytes compressed).
 * @param proof - The 96-byte DLEQ proof.
 * @param context - Optional swap context (e.g. hashLock hex) to verify proof binding.
 * @returns true if the proof is valid.
 */
export function verifyCrossCurveDleq(
    ed25519Point: Uint8Array,
    secp256k1Point: Uint8Array,
    proof: Uint8Array,
    context?: string,
): boolean {
    if (proof.length !== DLEQ_PROOF_LENGTH) {
        console.warn(`[DLEQ] Invalid proof length: ${proof.length} (expected ${DLEQ_PROOF_LENGTH})`);
        return false;
    }

    try {
        // 1. Parse proof: c (32 bytes) + s (64 bytes BE)
        const cBytes = proof.subarray(0, 32);
        const sBytes = proof.subarray(32, 96);

        const cInt = bytesToBigintBE(cBytes);
        const sInt = bytesToBigintBE(sBytes);

        // Reject zero challenge
        if (cInt === 0n) {
            console.warn('[DLEQ] Challenge scalar is zero — rejecting');
            return false;
        }

        // Reject zero or excessively large s
        if (sInt === 0n || sInt >= (1n << 512n)) {
            console.warn('[DLEQ] Invalid response scalar');
            return false;
        }

        // 2. Decode public keys and reject identity points
        const pEd = ed25519.Point.fromHex(toHex(ed25519Point));
        const pSec = secp256k1.Point.fromHex(toHex(secp256k1Point));

        // Cofactor check: reject small-order ed25519 points (8 * P == identity means torsion)
        if (pEd.equals(ed25519.Point.ZERO) || pEd.multiply(8n).equals(ed25519.Point.ZERO)) {
            console.warn('[DLEQ] Rejected ed25519 small-order torsion point');
            return false;
        }
        if (pSec.equals(secp256k1.Point.ZERO)) {
            console.warn('[DLEQ] Rejected secp256k1 identity point');
            return false;
        }

        // 3. Reduce s and c modulo each curve order
        const sEd = sInt % ED25519_ORDER;
        const cEd = cInt % ED25519_ORDER;
        const sSec = sInt % SECP256K1_ORDER;
        const cSec = cInt % SECP256K1_ORDER;

        if (sEd === 0n || cEd === 0n || sSec === 0n || cSec === 0n) {
            console.warn('[DLEQ] Degenerate scalar reduction');
            return false;
        }

        // 4. R_ed' = s_ed * G_ed + c_ed * P_ed
        const rEdPrime = ed25519.Point.BASE.multiply(sEd).add(pEd.multiply(cEd));
        const rEdPrimeBytes = rEdPrime.toBytes();

        // 5. R_sec' = s_sec * G_sec + c_sec * P_sec
        const rSecPrime = secp256k1.Point.BASE.multiply(sSec).add(pSec.multiply(cSec));
        const rSecPrimeBytes = rSecPrime.toBytes(true); // 33 bytes compressed

        // 6. c' = SHA-256(R_ed' || R_sec' || P_ed || P_sec || domain || context)
        const cPrime = computeDleqChallenge(rEdPrimeBytes, rSecPrimeBytes, ed25519Point, secp256k1Point, context);

        // 7. Constant-time compare c' === c
        return constantTimeEqual(cPrime, cBytes);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[DLEQ] Verification failed: ${msg}`);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Scalar <-> bytes helpers
// ---------------------------------------------------------------------------

/** Converts a 32-byte little-endian Uint8Array to a BigInt scalar. */
function bytesToScalarLE(bytes: Uint8Array): bigint {
    let result = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
        const byte = bytes[i];
        if (byte !== undefined) {
            result = result * 256n + BigInt(byte);
        }
    }
    return result;
}

/** Converts a big-endian Uint8Array to an unsigned BigInt. */
function bytesToBigintBE(bytes: Uint8Array): bigint {
    let result = 0n;
    for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (byte !== undefined) {
            result = result * 256n + BigInt(byte);
        }
    }
    return result;
}

/** Constant-time comparison of two Uint8Arrays. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return diff === 0;
}
