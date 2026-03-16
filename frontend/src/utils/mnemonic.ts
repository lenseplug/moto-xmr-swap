/**
 * BIP39 mnemonic-based swap secret derivation.
 *
 * Each swap gets a fresh 12-word mnemonic (128-bit entropy).
 * All cryptographic keys are deterministically derived via PBKDF2 + HKDF,
 * so the user only needs to write down 12 words to recover everything.
 */
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { bytesToScalar, scalarToBytes, ed25519PublicFromPrivate, ED25519_ORDER } from './ed25519';
import { uint8ArrayToHex } from './hashlock';
import { secp256k1PubFromScalar, generateDleqProof } from './dleq';

/** PBKDF2 salt for domain separation from Bitcoin BIP39 wallets. */
const PBKDF2_SALT = 'moto-xmr-swap';
const PBKDF2_ITERATIONS = 2048;

export interface AliceSwapKeys {
    /** Alice's ed25519 spend private key = HTLC preimage (hex). */
    readonly secret: string;
    /** Alice's ed25519 spend public key (hex). */
    readonly aliceEd25519Pub: string;
    /** Alice's ed25519 view private key (hex). */
    readonly aliceViewKey: string;
    /** SHA-256(secret) as bigint for on-chain hashLock. */
    readonly hashLock: bigint;
    /** SHA-256(secret) as hex. */
    readonly hashLockHex: string;
    /** Alice's secp256k1 compressed public key (hex, 66 chars = 33 bytes). */
    readonly aliceSecp256k1Pub: string;
    /** Cross-curve DLEQ proof (hex, 192 chars = 96 bytes). */
    readonly aliceDleqProof: string;
    /** Deterministic recovery token for authenticating secret submission (hex). */
    readonly recoveryToken: string;
}

export interface BobSwapKeys {
    /** Bob's ed25519 spend private key (hex). */
    readonly bobSpendKey: string;
    /** Bob's ed25519 spend public key (hex). */
    readonly bobEd25519PubKey: string;
    /** Bob's ed25519 view private key (hex). */
    readonly bobViewKey: string;
    /** Deterministic claim token for WebSocket auth (hex). */
    readonly claimTokenHex: string;
    /** Bob's secp256k1 compressed public key (hex, 66 chars = 33 bytes). */
    readonly bobSecp256k1Pub: string;
    /** Cross-curve DLEQ proof (hex, 192 chars = 96 bytes). */
    readonly bobDleqProof: string;
}

/**
 * Generates a fresh 12-word BIP39 mnemonic (128-bit entropy).
 */
export function generateSwapMnemonic(): string {
    return generateMnemonic(english, 128);
}

/**
 * Validates a BIP39 mnemonic (checksum + word list + 12-word enforcement).
 * Only 12-word mnemonics (128-bit entropy) are accepted for MOTO-XMR swaps.
 * Other word counts (15, 18, 21, 24) are valid BIP39 but rejected here
 * to prevent accidental use of Bitcoin wallet mnemonics.
 */
export function validateSwapMnemonic(mnemonic: string): boolean {
    const trimmed = mnemonic.trim().toLowerCase();
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
    if (words.length !== 12) return false;
    return validateMnemonic(trimmed, english);
}

/**
 * Derives the 64-byte seed from a mnemonic via PBKDF2-HMAC-SHA512.
 */
function deriveSeed(mnemonic: string): Uint8Array {
    const normalized = mnemonic.trim().toLowerCase();
    const mnemonicBytes = new TextEncoder().encode(normalized);
    const saltBytes = new TextEncoder().encode(PBKDF2_SALT);
    return pbkdf2(sha512, mnemonicBytes, saltBytes, {
        c: PBKDF2_ITERATIONS,
        dkLen: 64,
    });
}

/**
 * Derives a 32-byte ed25519 scalar from the seed using HKDF-SHA256.
 * The result is reduced mod l (ed25519 curve order).
 */
function deriveScalar(seed: Uint8Array, info: string): Uint8Array {
    const infoBytes = new TextEncoder().encode(info);
    const raw = hkdf(sha256, seed, undefined, infoBytes, 32);
    const scalar = bytesToScalar(raw) % ED25519_ORDER;
    return scalarToBytes(scalar);
}

/**
 * Derives Alice's keys from a mnemonic.
 * - Spend key = HTLC preimage
 * - hashLock = SHA-256(spend key)
 * - View key for XMR monitoring
 */
export async function deriveAliceKeys(mnemonic: string): Promise<AliceSwapKeys> {
    const seed = deriveSeed(mnemonic);

    const spendKeyBytes = deriveScalar(seed, 'alice-spend-key');
    const secret = uint8ArrayToHex(spendKeyBytes);

    const pubKeyBytes = ed25519PublicFromPrivate(spendKeyBytes);
    const aliceEd25519Pub = uint8ArrayToHex(pubKeyBytes);

    const viewKeyBytes = deriveScalar(seed, 'alice-view-key');
    const aliceViewKey = uint8ArrayToHex(viewKeyBytes);

    const hashBytes = sha256(spendKeyBytes);
    const hashLockHex = uint8ArrayToHex(hashBytes);
    const hashLock = BigInt('0x' + hashLockHex);

    // Cross-curve DLEQ proof: proves ed25519 key derived from same scalar as secp256k1 key.
    // Bound to hashLock to prevent cross-swap replay attacks.
    const secpPubBytes = secp256k1PubFromScalar(spendKeyBytes);
    const aliceSecp256k1Pub = uint8ArrayToHex(secpPubBytes);
    const dleqProofBytes = await generateDleqProof(spendKeyBytes, pubKeyBytes, secpPubBytes, hashLockHex);
    const aliceDleqProof = uint8ArrayToHex(dleqProofBytes);

    // Deterministic recovery token (authenticates secret submission + recovery)
    const recoveryInfoBytes = new TextEncoder().encode('recovery-token');
    const recoveryBytes = hkdf(sha256, seed, undefined, recoveryInfoBytes, 32);
    const recoveryToken = uint8ArrayToHex(recoveryBytes);

    return { secret, aliceEd25519Pub, aliceViewKey, hashLock, hashLockHex, aliceSecp256k1Pub, aliceDleqProof, recoveryToken };
}

/**
 * Derives Bob's keys from a mnemonic.
 * - Spend key + view key for split-key Monero address
 * - Deterministic claim token for WebSocket auth
 */
export async function deriveBobKeys(mnemonic: string, hashLock?: string): Promise<BobSwapKeys> {
    const seed = deriveSeed(mnemonic);

    const spendKeyBytes = deriveScalar(seed, 'bob-spend-key');
    const bobSpendKey = uint8ArrayToHex(spendKeyBytes);

    const pubKeyBytes = ed25519PublicFromPrivate(spendKeyBytes);
    const bobEd25519PubKey = uint8ArrayToHex(pubKeyBytes);

    const viewKeyBytes = deriveScalar(seed, 'bob-view-key');
    const bobViewKey = uint8ArrayToHex(viewKeyBytes);

    // Deterministic claim token
    const infoBytes = new TextEncoder().encode('claim-token');
    const tokenBytes = hkdf(sha256, seed, undefined, infoBytes, 32);
    const claimTokenHex = uint8ArrayToHex(tokenBytes);

    // Cross-curve DLEQ proof: proves ed25519 key derived from same scalar as secp256k1 key.
    // Bound to hashLock to prevent cross-swap replay attacks.
    const secpPubBytes = secp256k1PubFromScalar(spendKeyBytes);
    const bobSecp256k1Pub = uint8ArrayToHex(secpPubBytes);
    const dleqProofBytes = await generateDleqProof(spendKeyBytes, pubKeyBytes, secpPubBytes, hashLock);
    const bobDleqProof = uint8ArrayToHex(dleqProofBytes);

    return { bobSpendKey, bobEd25519PubKey, bobViewKey, claimTokenHex, bobSecp256k1Pub, bobDleqProof };
}
