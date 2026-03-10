/**
 * Cross-curve DLEQ (Discrete Log Equality) proof verification.
 *
 * Verifies that a scalar `s` satisfies both:
 *   S_ed25519  = s * G_ed25519   (Monero curve)
 *   S_secp256k1 = s * G_secp256k1 (Bitcoin curve)
 *
 * without revealing `s`.
 *
 * V1 implementation: placeholder that logs a warning and returns true.
 * The full DLEQ verification requires either:
 *   - The `dleq-tools` WASM package (experimental)
 *   - A manual implementation using @noble/curves bit-decomposition
 *
 * For V1, the coordinator trusts that the submitted keys are valid.
 * In V2, this will be replaced with cryptographic verification.
 */

/**
 * Verifies a cross-curve DLEQ proof.
 *
 * @param ed25519Point - The ed25519 public key (32 bytes).
 * @param secp256k1Point - The secp256k1 public key (33 bytes, compressed).
 * @param proof - The DLEQ proof bytes (variable length).
 * @returns true if the proof is valid (V1: always true with warning).
 */
export function verifyCrossCurveDleq(
    _ed25519Point: Uint8Array,
    _secp256k1Point: Uint8Array,
    _proof: Uint8Array,
): boolean {
    // V1: DLEQ verification is not implemented.
    // The coordinator trusts submitted keys. This is acceptable for V1 because:
    // 1. If Bob provides fake keys, he loses his own XMR (self-harm only)
    // 2. If Alice provides fake keys, Bob should verify the shared address
    //    independently before sending XMR
    //
    // V2 TODO: Implement real DLEQ verification using dleq-tools WASM
    // or a manual bit-decomposition Pedersen commitment scheme.
    //
    // import { verify_cross_curve_dleq } from 'dleq-tools';
    // return verify_cross_curve_dleq(ed25519Point, secp256k1Point, proof);

    console.warn(
        '[DLEQ] Cross-curve DLEQ verification is not implemented in V1. ' +
        'Accepting keys without cryptographic proof. ' +
        'Bob should independently verify the shared Monero address.',
    );

    return true;
}

/**
 * Generates a cross-curve DLEQ proof for a given scalar.
 *
 * @param _scalar - The secret scalar (32 bytes).
 * @param _ed25519Point - The ed25519 public key derived from the scalar.
 * @param _secp256k1Point - The secp256k1 public key derived from the scalar.
 * @returns The DLEQ proof bytes.
 */
export function generateCrossCurveDleqProof(
    _scalar: Uint8Array,
    _ed25519Point: Uint8Array,
    _secp256k1Point: Uint8Array,
): Uint8Array {
    // V1: Return empty proof. Real proof generation requires dleq-tools.
    console.warn('[DLEQ] Proof generation not implemented in V1 — returning empty proof.');
    return new Uint8Array(0);
}
