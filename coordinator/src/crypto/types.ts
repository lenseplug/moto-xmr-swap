/**
 * Types for cross-curve cryptographic operations used in coordinator-mediated swaps.
 *
 * The split-key swap protocol uses ed25519 (Monero) and secp256k1 (Bitcoin/OPNet)
 * key pairs with DLEQ proofs to ensure the same discrete logarithm underlies
 * keys on both curves.
 */

/** An ed25519 key pair (Monero curve). */
export interface IEd25519KeyPair {
    /** Private scalar (32 bytes). */
    readonly privateKey: Uint8Array;
    /** Public point (32 bytes, compressed). */
    readonly publicKey: Uint8Array;
}

/**
 * A cross-curve key pair: a single scalar that produces valid public keys
 * on both ed25519 and secp256k1, with a DLEQ proof linking them.
 */
export interface ICrossCurveKeyPair {
    /** The ed25519 key pair (private + public). */
    readonly ed25519: IEd25519KeyPair;
    /** The corresponding secp256k1 public key (33 bytes, compressed). */
    readonly secp256k1PublicKey: Uint8Array;
    /** Cross-curve DLEQ proof (variable length, opaque). */
    readonly dleqProof: Uint8Array;
}

/** A Monero shared address derived from two parties' key shares. */
export interface ISharedMoneroAddress {
    /** The standard Monero address string. */
    readonly address: string;
    /** Combined public spend key: S_a + S_b on ed25519 (32 bytes). */
    readonly publicSpendKey: Uint8Array;
    /** Combined public view key: V_a + V_b on ed25519 (32 bytes). */
    readonly publicViewKey: Uint8Array;
}

/** Monero network type for address encoding. */
export type MoneroNetwork = 'mainnet' | 'stagenet';

/**
 * Key material submitted by Alice (MOTO depositor) when creating a split-key swap.
 * Alice's secret scalar s_a is used as the HTLC preimage: hash_lock = SHA256(s_a).
 */
export interface IAliceKeyMaterial {
    /** Alice's ed25519 public key (32 bytes hex). */
    readonly aliceEd25519PubKey: string;
    /** Alice's DLEQ proof (hex). */
    readonly aliceDleqProof: string;
    /** Alice's ed25519 private view key (32 bytes hex). Shared with Bob for monitoring. */
    readonly aliceViewKey: string;
}

/**
 * Key material submitted by Bob (XMR sender) when taking a split-key swap.
 * Bob keeps his secret scalar s_b private until the swap completes.
 */
export interface IBobKeyMaterial {
    /** Bob's ed25519 public key (32 bytes hex). */
    readonly bobEd25519PubKey: string;
    /** Bob's DLEQ proof (hex). */
    readonly bobDleqProof: string;
    /** Bob's ed25519 private view key (32 bytes hex). Shared with Alice for monitoring. */
    readonly bobViewKey: string;
}
