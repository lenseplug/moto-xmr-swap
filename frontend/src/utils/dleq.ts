/**
 * Cross-curve DLEQ (Discrete Log Equality) proofs between Ed25519 and Secp256k1.
 *
 * Proves that the same scalar `x` underlies public keys on both curves:
 *   P_ed = x * G_ed  (Ed25519)
 *   P_sec = (x mod n) * G_sec (Secp256k1)
 *
 * v2 proof format: c (32 bytes) || s (64 bytes big-endian) = 96 bytes
 *
 * Uses a SINGLE response scalar computed in the integers (no modular reduction),
 * which binds both curves — verification reduces s mod each order independently.
 * This prevents the v1 forgery where independent nonces per curve allowed trivial fakes.
 *
 * Domain separator: 'moto-xmr-dleq-v2'
 *
 * Uses Web Crypto API (SHA-256, getRandomValues) — browser-compatible, no Node.js deps.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToScalar, ED25519_ORDER } from './ed25519';

/** Domain separator v2 — rejects v1 proofs and prevents cross-protocol replay. */
const DOMAIN_SEPARATOR = 'moto-xmr-dleq-v2';

/** Secp256k1 curve order (n). */
const SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

/** Proof length: c (32) + s (64) = 96 bytes. */
const PROOF_LENGTH = 96;

/**
 * Converts a BigInt to a fixed-length big-endian Uint8Array.
 */
function bigintToBytesBE(value: bigint, length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    let remaining = value;
    for (let i = length - 1; i >= 0; i--) {
        bytes[i] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    return bytes;
}

/**
 * Converts a big-endian Uint8Array to an unsigned BigInt.
 */
function bytesToBigintBE(bytes: Uint8Array): bigint {
    let result = 0n;
    for (let i = 0; i < bytes.length; i++) {
        result = result * 256n + BigInt(bytes[i] ?? 0);
    }
    return result;
}

/**
 * Constant-time comparison of two Uint8Arrays.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return diff === 0;
}

/**
 * Computes SHA-256(R_ed || R_sec || P_ed || P_sec || domain || context).
 * The optional context parameter binds the proof to a specific swap (prevents replay).
 */
async function computeChallenge(
    rEd: Uint8Array,
    rSec: Uint8Array,
    pEd: Uint8Array,
    pSec: Uint8Array,
    context?: string,
): Promise<Uint8Array> {
    const domainBytes = new TextEncoder().encode(DOMAIN_SEPARATOR);
    const contextBytes = context ? new TextEncoder().encode(':' + context) : new Uint8Array(0);
    const input = new Uint8Array(rEd.length + rSec.length + pEd.length + pSec.length + domainBytes.length + contextBytes.length);
    let offset = 0;
    input.set(rEd, offset); offset += rEd.length;
    input.set(rSec, offset); offset += rSec.length;
    input.set(pEd, offset); offset += pEd.length;
    input.set(pSec, offset); offset += pSec.length;
    input.set(domainBytes, offset); offset += domainBytes.length;
    input.set(contextBytes, offset);
    const digest = await crypto.subtle.digest('SHA-256', input);
    return new Uint8Array(digest);
}

/**
 * Derives the compressed secp256k1 public key from a private scalar.
 *
 * @param privateKey - 32-byte private key (little-endian, ed25519 convention)
 * @returns 33-byte compressed secp256k1 public key
 */
export function secp256k1PubFromScalar(privateKey: Uint8Array): Uint8Array {
    const scalar = bytesToScalar(privateKey) % SECP256K1_ORDER;
    if (scalar === 0n) throw new Error('Invalid scalar for secp256k1 (zero)');
    const point = secp256k1.Point.BASE.multiply(scalar);
    return point.toBytes(true); // 33 bytes compressed
}

/**
 * Generates a cross-curve DLEQ proof (v2 — single response scalar).
 *
 * The response scalar `s = k - c * x` is computed over the integers (not reduced
 * mod any curve order). Verification reduces s and c mod each order independently,
 * binding both curves to the same underlying scalar.
 *
 * Nonce `k` is chosen from [2^511, 2^512) to guarantee s > 0 (since c*x < 2^509).
 *
 * @param scalar - The private scalar as a 32-byte Uint8Array (little-endian)
 * @param edPub - The ed25519 public key (32 bytes)
 * @param secPub - The secp256k1 compressed public key (33 bytes)
 * @param context - Optional swap context (e.g. hashLock hex) to bind proof to a specific swap
 * @returns 96-byte proof: c (32) || s (64 BE)
 */
export async function generateDleqProof(
    scalar: Uint8Array,
    edPub: Uint8Array,
    secPub: Uint8Array,
    context?: string,
): Promise<Uint8Array> {
    const x = bytesToScalar(scalar);

    if (x === 0n || x >= ED25519_ORDER) {
        throw new Error('Invalid scalar: must be in [1, l-1]');
    }

    // 1. Random nonce k in [2^511, 2^512)
    //    Setting bit 511 guarantees k >= 2^511, ensuring s = k - c*x > 0
    //    since c*x < 2^256 * 2^253 = 2^509 << 2^511.
    const kRaw = crypto.getRandomValues(new Uint8Array(64));
    let k = bytesToBigintBE(kRaw);
    k = k | (1n << 511n); // force k >= 2^511

    // 2. Compute commitments on each curve using k reduced mod each order
    const kEd = k % ED25519_ORDER;
    const kSec = k % SECP256K1_ORDER;
    if (kEd === 0n || kSec === 0n) {
        throw new Error('Degenerate nonce — retry');
    }

    const rEdBytes = ed25519.Point.BASE.multiply(kEd).toBytes(); // 32 bytes
    const rSecBytes = secp256k1.Point.BASE.multiply(kSec).toBytes(true); // 33 bytes

    // 3. Challenge: c = SHA-256(R_ed || R_sec || P_ed || P_sec || domain || context)
    const cBytes = await computeChallenge(rEdBytes, rSecBytes, edPub, secPub, context);
    const cInt = bytesToBigintBE(cBytes);

    // 4. Response: s = k - c * x (in the integers — no modular reduction)
    const s = k - cInt * x;
    if (s <= 0n) {
        throw new Error('DLEQ: response scalar is non-positive — should not happen with k >= 2^511');
    }

    // 5. Encode proof: c (32 bytes raw SHA-256) || s (64 bytes big-endian)
    const proof = new Uint8Array(PROOF_LENGTH);
    proof.set(cBytes, 0);
    proof.set(bigintToBytesBE(s, 64), 32);

    return proof;
}

/**
 * Verifies a cross-curve DLEQ proof (v2 — single response scalar).
 *
 * Reduces the single response scalar s and challenge c modulo each curve's order,
 * recomputes the commitments, and checks the challenge hash.
 *
 * @param edPub - The ed25519 public key (32 bytes)
 * @param secPub - The secp256k1 compressed public key (33 bytes)
 * @param proof - The 96-byte proof: c (32) || s (64 BE)
 * @param context - Optional swap context (e.g. hashLock hex) to verify proof binding
 * @returns true if the proof is valid
 */
export async function verifyDleqProof(
    edPub: Uint8Array,
    secPub: Uint8Array,
    proof: Uint8Array,
    context?: string,
): Promise<boolean> {
    if (proof.length !== PROOF_LENGTH) {
        if (!import.meta.env.PROD) console.warn(`[DLEQ] Invalid proof length: ${proof.length} (expected ${PROOF_LENGTH})`);
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
            if (!import.meta.env.PROD) console.warn('[DLEQ] Invalid challenge scalar (zero)');
            return false;
        }

        // Reject zero or excessively large s
        if (sInt === 0n || sInt >= (1n << 512n)) {
            if (!import.meta.env.PROD) console.warn('[DLEQ] Invalid response scalar');
            return false;
        }

        // 2. Decode public keys and reject identity points
        const edHex = Array.from(edPub, (b) => b.toString(16).padStart(2, '0')).join('');
        const secHex = Array.from(secPub, (b) => b.toString(16).padStart(2, '0')).join('');
        const pEd = ed25519.Point.fromHex(edHex);
        const pSec = secp256k1.Point.fromHex(secHex);

        if (pEd.equals(ed25519.Point.ZERO)) {
            if (!import.meta.env.PROD) console.warn('[DLEQ] Rejected ed25519 identity point');
            return false;
        }
        // Reject small-order torsion points on ed25519 (cofactor = 8).
        // These points have order dividing 8 and yield P * 8 == identity.
        // Accepting them would allow a DLEQ proof for a key with no real discrete log.
        if (pEd.multiply(8n).equals(ed25519.Point.ZERO)) {
            if (!import.meta.env.PROD) console.warn('[DLEQ] Rejected ed25519 small-order torsion point');
            return false;
        }
        if (pSec.equals(secp256k1.Point.ZERO)) {
            if (!import.meta.env.PROD) console.warn('[DLEQ] Rejected secp256k1 identity point');
            return false;
        }

        // 3. Reduce s and c modulo each curve order
        const sEd = sInt % ED25519_ORDER;
        const cEd = cInt % ED25519_ORDER;
        const sSec = sInt % SECP256K1_ORDER;
        const cSec = cInt % SECP256K1_ORDER;

        if (sEd === 0n || cEd === 0n || sSec === 0n || cSec === 0n) {
            if (!import.meta.env.PROD) console.warn('[DLEQ] Degenerate scalar reduction');
            return false;
        }

        // 4. R_ed' = s_ed * G_ed + c_ed * P_ed
        const rEdPrime = ed25519.Point.BASE.multiply(sEd).add(pEd.multiply(cEd));
        const rEdPrimeBytes = rEdPrime.toBytes();

        // 5. R_sec' = s_sec * G_sec + c_sec * P_sec
        const rSecPrime = secp256k1.Point.BASE.multiply(sSec).add(pSec.multiply(cSec));
        const rSecPrimeBytes = rSecPrime.toBytes(true); // 33 bytes compressed

        // 6. c' = SHA-256(R_ed' || R_sec' || P_ed || P_sec || domain || context)
        const cPrime = await computeChallenge(rEdPrimeBytes, rSecPrimeBytes, edPub, secPub, context);

        // 7. Constant-time compare c' === c
        return constantTimeEqual(cPrime, cBytes);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!import.meta.env.PROD) console.warn(`[DLEQ] Verification failed: ${msg}`);
        return false;
    }
}
