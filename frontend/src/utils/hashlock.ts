/**
 * Hash-lock generation utilities for atomic swaps.
 * Uses SHA-256 (Bitcoin's hash function, not Keccak-256).
 * All operations use Uint8Array — never Buffer.
 */
import { generateEd25519KeyPair } from './ed25519';
import type { LocalSwapSecret } from '../types/swap';

/**
 * Secrets and claim tokens use localStorage (persists across refreshes,
 * tab closes, and browser restarts). This prevents secret loss from
 * accidental page refresh — which would make a swap uncompletable.
 * Secrets are cleaned up when swaps reach terminal states (COMPLETED/REFUNDED).
 */
const LOCAL_SECRETS_KEY = 'moto_xmr_swap_secrets';
const CLAIM_TOKENS_KEY = 'moto_xmr_claim_tokens';
const BOB_KEYS_KEY = 'moto_xmr_bob_keys';

/**
 * Generates a cryptographically random 32-byte secret and computes its SHA-256 hash.
 * The hash becomes the hashLock stored on-chain.
 * The secret is stored locally and revealed during the claim step.
 *
 * @returns The secret (hex) and hashLock (bigint for contract call)
 */
export async function generateSecretAndHashLock(): Promise<{
    readonly secret: string;
    readonly hashLock: bigint;
    readonly hashLockHex: string;
}> {
    const secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secretHex = uint8ArrayToHex(secretBytes);

    const hashBytes = await crypto.subtle.digest('SHA-256', secretBytes);
    const hashHex = uint8ArrayToHex(new Uint8Array(hashBytes));
    const hashLock = BigInt('0x' + hashHex);

    return { secret: secretHex, hashLock, hashLockHex: hashHex };
}

/**
 * Generates a swap secret using ed25519 split-key generation.
 *
 * In split-key mode, Alice's ed25519 private spend key IS the secret.
 * hash_lock = SHA-256(spend_private_key).
 * A separate ed25519 view keypair is generated for monitoring.
 *
 * When Bob claims MOTO (revealing the preimage), the coordinator can reconstruct
 * the full Monero spend key: s_full = s_alice + s_bob.
 *
 * NOTE: The coordinator holds both key shares and is trusted with the XMR side.
 *
 * @returns The secret (hex), hashLock (bigint), view key (hex), and ed25519 pub key (hex).
 */
export async function generateTrustlessSecret(): Promise<{
    readonly secret: string;
    readonly hashLock: bigint;
    readonly hashLockHex: string;
    readonly aliceViewKey: string;
    readonly aliceEd25519Pub: string;
}> {
    // Generate Alice's spend keypair — private key is the HTLC preimage
    const spendKeyPair = generateEd25519KeyPair();
    const secret = uint8ArrayToHex(spendKeyPair.privateKey);
    const aliceEd25519Pub = uint8ArrayToHex(spendKeyPair.publicKey);

    // Generate Alice's view keypair — shared with coordinator for XMR monitoring
    const viewKeyPair = generateEd25519KeyPair();
    const aliceViewKey = uint8ArrayToHex(viewKeyPair.privateKey);

    // hash_lock = SHA-256(spend_private_key)
    const hashBytes = await crypto.subtle.digest('SHA-256', spendKeyPair.privateKey.buffer as ArrayBuffer);
    const hashHex = uint8ArrayToHex(new Uint8Array(hashBytes));
    const hashLock = BigInt('0x' + hashHex);

    return { secret, hashLock, hashLockHex: hashHex, aliceViewKey, aliceEd25519Pub };
}

/**
 * Converts a Uint8Array to a lowercase hex string.
 *
 * @param bytes - Input bytes
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Converts a hex string to Uint8Array.
 *
 * @param hex - Hex string (with or without 0x prefix)
 */
export function hexToUint8Array(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Computes SHA-256 of a hex-encoded preimage and returns the hash as a bigint.
 *
 * @param secretHex - The secret preimage as a hex string
 */
export async function hashSecret(secretHex: string): Promise<bigint> {
    const secretBytes = hexToUint8Array(secretHex);
    const hashBytes = await crypto.subtle.digest('SHA-256', secretBytes.buffer as ArrayBuffer);
    const hashHex = uint8ArrayToHex(new Uint8Array(hashBytes));
    return BigInt('0x' + hashHex);
}

/**
 * Converts a secret hex string to a bigint for use in the claim() call.
 *
 * @param secretHex - The secret as a 64-char hex string
 */
export function secretHexToBigint(secretHex: string): bigint {
    const clean = secretHex.startsWith('0x') ? secretHex.slice(2) : secretHex;
    return BigInt('0x' + clean);
}

/**
 * Persists a swap secret to localStorage so the user can claim later.
 *
 * @param swapId - The swap ID (decimal string)
 * @param secret - The secret preimage hex
 * @param hashLock - The hash lock hex
 */
export function saveLocalSwapSecret(
    swapId: string,
    secret: string,
    hashLock: string,
    aliceViewKey?: string,
): void {
    const secrets = loadLocalSwapSecrets();
    const entry: LocalSwapSecret = {
        swapId,
        secret,
        hashLock,
        createdAt: Date.now(),
        ...(aliceViewKey !== undefined ? { aliceViewKey } : {}),
    };
    secrets.push(entry);
    localStorage.setItem(LOCAL_SECRETS_KEY, JSON.stringify(secrets));
}

/**
 * Loads all session-stored swap secrets.
 */
export function loadLocalSwapSecrets(): LocalSwapSecret[] {
    try {
        const raw = localStorage.getItem(LOCAL_SECRETS_KEY);
        if (!raw) return [];
        return JSON.parse(raw) as LocalSwapSecret[];
    } catch {
        return [];
    }
}

/**
 * Retrieves the secret for a specific swap ID.
 *
 * @param swapId - The swap ID (decimal string)
 */
export function getLocalSwapSecret(swapId: string): LocalSwapSecret | null {
    const secrets = loadLocalSwapSecrets();
    return secrets.find((s) => s.swapId === swapId) ?? null;
}

/**
 * Removes the secret for a specific swap ID from localStorage.
 * Call this when a swap reaches a terminal state (COMPLETED, REFUNDED, EXPIRED).
 *
 * @param swapId - The swap ID (decimal string)
 */
export function clearLocalSwapSecret(swapId: string): void {
    try {
        const secrets = loadLocalSwapSecrets().filter((s) => s.swapId !== swapId);
        localStorage.setItem(LOCAL_SECRETS_KEY, JSON.stringify(secrets));
    } catch {
        // localStorage unavailable — ignore
    }
}

/**
 * Saves a claim_token for a swap in localStorage.
 * The claim_token is used to authenticate WebSocket subscriptions.
 *
 * @param swapId - The swap ID (decimal string)
 * @param claimToken - The 64-char hex claim token from the coordinator
 */
export function saveClaimToken(swapId: string, claimToken: string): void {
    // Validate token format: must be exactly 64 hex characters (256-bit random)
    if (!/^[0-9a-f]{64}$/i.test(claimToken)) {
        console.error('[saveClaimToken] Invalid claim token format — rejecting');
        return;
    }
    try {
        const raw = localStorage.getItem(CLAIM_TOKENS_KEY);
        const tokens: Record<string, string> = raw ? (JSON.parse(raw) as Record<string, string>) : {};
        tokens[swapId] = claimToken;
        localStorage.setItem(CLAIM_TOKENS_KEY, JSON.stringify(tokens));
    } catch {
        // localStorage unavailable — ignore
    }
}

/**
 * Retrieves the claim_token for a specific swap ID.
 *
 * @param swapId - The swap ID (decimal string)
 */
export function getClaimToken(swapId: string): string | null {
    try {
        const raw = localStorage.getItem(CLAIM_TOKENS_KEY);
        if (!raw) return null;
        const tokens = JSON.parse(raw) as Record<string, string>;
        return tokens[swapId] ?? null;
    } catch {
        return null;
    }
}

/**
 * Removes the claim_token for a specific swap ID from localStorage.
 *
 * @param swapId - The swap ID (decimal string)
 */
export function clearClaimToken(swapId: string): void {
    try {
        const raw = localStorage.getItem(CLAIM_TOKENS_KEY);
        if (!raw) return;
        const tokens = JSON.parse(raw) as Record<string, string>;
        delete tokens[swapId];
        localStorage.setItem(CLAIM_TOKENS_KEY, JSON.stringify(tokens));
    } catch {
        // localStorage unavailable — ignore
    }
}

// ---------------------------------------------------------------------------
// Bob key material persistence (taker side)
// ---------------------------------------------------------------------------

/**
 * Stored Bob key material for retrying key submission if it fails.
 */
export interface StoredBobKeys {
    readonly swapId: string;
    readonly bobEd25519PubKey: string;
    readonly bobViewKey: string;
    readonly bobSpendKey: string;
    readonly bobKeyProof: string;
    readonly createdAt: number;
    /** Whether keys have been successfully submitted to the coordinator. */
    submitted: boolean;
}

/**
 * Saves Bob's generated key material to localStorage before submission.
 * This ensures keys aren't lost if the submission fails.
 */
export function saveBobKeys(keys: Omit<StoredBobKeys, 'createdAt' | 'submitted'>): void {
    try {
        const raw = localStorage.getItem(BOB_KEYS_KEY);
        const all: Record<string, StoredBobKeys> = raw ? (JSON.parse(raw) as Record<string, StoredBobKeys>) : {};
        all[keys.swapId] = { ...keys, createdAt: Date.now(), submitted: false };
        localStorage.setItem(BOB_KEYS_KEY, JSON.stringify(all));
    } catch {
        // localStorage unavailable — ignore
    }
}

/**
 * Marks Bob's keys as successfully submitted for a swap.
 */
export function markBobKeysSubmitted(swapId: string): void {
    try {
        const raw = localStorage.getItem(BOB_KEYS_KEY);
        if (!raw) return;
        const all = JSON.parse(raw) as Record<string, StoredBobKeys>;
        if (all[swapId]) {
            all[swapId] = { ...all[swapId], submitted: true };
            localStorage.setItem(BOB_KEYS_KEY, JSON.stringify(all));
        }
    } catch {
        // localStorage unavailable — ignore
    }
}

/**
 * Retrieves Bob's stored key material for a swap (if any).
 */
export function getBobKeys(swapId: string): StoredBobKeys | null {
    try {
        const raw = localStorage.getItem(BOB_KEYS_KEY);
        if (!raw) return null;
        const all = JSON.parse(raw) as Record<string, StoredBobKeys>;
        return all[swapId] ?? null;
    } catch {
        return null;
    }
}

/**
 * Removes Bob's key material for a swap (terminal state cleanup).
 */
export function clearBobKeys(swapId: string): void {
    try {
        const raw = localStorage.getItem(BOB_KEYS_KEY);
        if (!raw) return;
        const all = JSON.parse(raw) as Record<string, StoredBobKeys>;
        delete all[swapId];
        localStorage.setItem(BOB_KEYS_KEY, JSON.stringify(all));
    } catch {
        // localStorage unavailable — ignore
    }
}
