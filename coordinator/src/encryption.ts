/**
 * Field-level encryption for sensitive swap data at rest.
 * Uses AES-256-GCM with a per-field random IV.
 *
 * Encrypted values are stored as: base64(iv || ciphertext || authTag)
 * - IV: 12 bytes (96-bit, GCM standard)
 * - Auth tag: 16 bytes (128-bit)
 *
 * The master key is derived from ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 * If ENCRYPTION_KEY is not set, encryption is disabled (plaintext fallback for dev).
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Prefix to identify encrypted values in the database. */
const ENCRYPTED_PREFIX = 'enc:';

/** Master key from ENCRYPTION_KEY env var. */
let masterKey: Uint8Array | null = null;

/**
 * Derived sub-keys via HKDF — domain separation so the AES encryption key
 * and HMAC index key are cryptographically independent. Using the same key
 * for both AES-GCM and HMAC-SHA256 is a subtle crypto anti-pattern:
 * it couples two different security properties to one key.
 */
let aesKey: Uint8Array | null = null;
let hmacKey: Uint8Array | null = null;

/** Salt for HKDF derivation (fixed, not secret — just domain binds). */
const HKDF_SALT = 'moto-xmr-coordinator-v1';

/**
 * Initializes the encryption module with the master key from environment.
 * Must be called at startup before any encrypt/decrypt operations.
 *
 * @returns true if encryption is enabled, false if running in plaintext mode.
 */
export function initEncryption(): boolean {
    const keyHex = process.env['ENCRYPTION_KEY'] ?? '';
    if (keyHex.length === 0) {
        // Allow plaintext ONLY when explicitly opted in for development AND not in production.
        const allowPlaintext = (process.env['ALLOW_PLAINTEXT_DEV'] ?? 'false').toLowerCase() === 'true';
        const isProduction = process.env['NODE_ENV'] === 'production' ||
            (process.env['REQUIRE_TLS'] ?? 'false').toLowerCase() === 'true';
        if (allowPlaintext && isProduction) {
            console.error(
                '[Encryption] FATAL: ALLOW_PLAINTEXT_DEV=true is FORBIDDEN in production (NODE_ENV=production or REQUIRE_TLS=true).\n' +
                '[Encryption] Set ENCRYPTION_KEY (64 hex chars) or remove ALLOW_PLAINTEXT_DEV.',
            );
            process.exit(1);
        }
        if (!allowPlaintext) {
            console.error(
                '[Encryption] FATAL: ENCRYPTION_KEY not set. Refusing to start with plaintext storage.\n' +
                '[Encryption] Set ENCRYPTION_KEY (64 hex chars) to encrypt preimages and keys at rest.\n' +
                '[Encryption] For development ONLY: set ALLOW_PLAINTEXT_DEV=true to bypass (NOT for production).',
            );
            process.exit(1);
        }
        console.warn('[Encryption] *** DEV MODE *** ALLOW_PLAINTEXT_DEV=true — sensitive fields stored in PLAINTEXT.');
        return false;
    }
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
        console.error('[Encryption] ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
        process.exit(1);
    }
    masterKey = hexToBytes(keyHex);

    // Derive domain-separated sub-keys via HKDF-SHA256.
    // AES key for encryption, HMAC key for indexed lookups.
    aesKey = new Uint8Array(hkdfSync('sha256', masterKey, HKDF_SALT, 'aes-256-gcm-encryption', 32));
    hmacKey = new Uint8Array(hkdfSync('sha256', masterKey, HKDF_SALT, 'hmac-sha256-index', 32));

    // Self-test: encrypt + decrypt a known value to catch key corruption early.
    // Without this, a corrupted key silently produces garbage on decrypt.
    const testPlaintext = 'encryption-self-test-v1';
    try {
        const encrypted = encryptField(testPlaintext);
        const decrypted = decryptField(encrypted);
        if (decrypted !== testPlaintext) {
            console.error('[Encryption] FATAL: Self-test failed — encrypt/decrypt round-trip mismatch.');
            process.exit(1);
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error(`[Encryption] FATAL: Self-test failed — ${msg}`);
        process.exit(1);
    }

    // Scrub the key from process.env to reduce exposure surface.
    // The key is now held only in the in-memory `masterKey` variable.
    delete process.env['ENCRYPTION_KEY'];

    console.log('[Encryption] Field-level encryption enabled (AES-256-GCM). Self-test passed.');
    return true;
}

/** Returns true if encryption is active. */
export function isEncryptionEnabled(): boolean {
    return masterKey !== null;
}

/**
 * Computes an HMAC-SHA256 of the given plaintext using the master encryption key.
 * Used to create indexed lookup columns for encrypted fields (e.g., claim_token_hmac)
 * without exposing the plaintext value. Returns null if encryption is disabled.
 */
export function computeHmac(plaintext: string): string | null {
    if (!hmacKey) return null;
    return createHmac('sha256', hmacKey).update(plaintext, 'utf8').digest('hex');
}

/**
 * Encrypts a plaintext string for storage.
 * Returns the encrypted value prefixed with 'enc:' for identification.
 * If encryption is disabled, returns the plaintext unchanged.
 *
 * @param plaintext - The value to encrypt.
 * @returns Encrypted string (or plaintext if encryption disabled).
 */
export function encryptField(plaintext: string): string {
    if (!aesKey) return plaintext;

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, aesKey, iv);
    const part1 = cipher.update(plaintext, 'utf8');
    const part2 = cipher.final();
    const authTag = cipher.getAuthTag();

    // Pack: iv || ciphertext || authTag
    const packed = concatUint8Arrays([iv, part1, part2, authTag]);
    return ENCRYPTED_PREFIX + uint8ToBase64(packed);
}

/**
 * Decrypts an encrypted field value.
 * If the value doesn't have the 'enc:' prefix, returns it as-is (plaintext fallback).
 *
 * @param stored - The stored value (encrypted or plaintext).
 * @returns The decrypted plaintext.
 */
export function decryptField(stored: string): string {
    if (!stored.startsWith(ENCRYPTED_PREFIX)) {
        // If encryption is enabled, a non-encrypted value in the DB is suspicious:
        // either a database tampering attempt, a missed migration, or data corruption.
        // Log a warning for forensics but still return the value (graceful degradation
        // for legacy data from before encryption was enabled).
        if (masterKey && stored.length > 0) {
            console.warn(`[Encryption] WARNING: Found unencrypted value in DB while encryption is enabled (length=${stored.length}). Possible data tampering or migration gap.`);
        }
        return stored;
    }
    if (!aesKey || !masterKey) {
        console.error('[Encryption] Cannot decrypt — ENCRYPTION_KEY not set but encrypted data found.');
        throw new Error('ENCRYPTION_KEY required to decrypt stored data');
    }

    const packed = base64ToUint8(stored.slice(ENCRYPTED_PREFIX.length));
    if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error('Encrypted data too short — corrupted or tampered');
    }

    const iv = packed.subarray(0, IV_LENGTH);
    const authTag = packed.subarray(packed.length - AUTH_TAG_LENGTH);
    const ciphertext = packed.subarray(IV_LENGTH, packed.length - AUTH_TAG_LENGTH);

    // Try HKDF-derived key first (new format), fall back to raw master key (legacy format).
    // This allows seamless migration: old data decrypts with masterKey, new data with aesKey.
    try {
        const decipher = createDecipheriv(ALGORITHM, aesKey, iv);
        decipher.setAuthTag(authTag);
        const part1 = decipher.update(ciphertext);
        const part2 = decipher.final();
        return new TextDecoder().decode(concatUint8Arrays([part1, part2]));
    } catch {
        // Legacy data encrypted with raw masterKey — log warning for audit trail.
        // The caller (storage layer) will re-encrypt with HKDF-derived key on next write.
        console.warn('[Encryption] Decrypting with legacy raw masterKey — data will be re-encrypted with HKDF key on next update');
        const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
        decipher.setAuthTag(authTag);
        const part1 = decipher.update(ciphertext);
        const part2 = decipher.final();
        return new TextDecoder().decode(concatUint8Arrays([part1, part2]));
    }
}

/**
 * Encrypts a field value if non-null, for use in storage updates.
 */
export function encryptIfPresent(value: string | null | undefined): string | null | undefined {
    if (value === null || value === undefined) return value;
    return encryptField(value);
}

/**
 * Decrypts a field value if non-null, for use in storage reads.
 */
export function decryptIfPresent(value: string | null): string | null {
    if (value === null || value === undefined) return null;
    return decryptField(value);
}

/**
 * Validates that an encrypted value can be decrypted with the current key.
 * Returns true if the value is plaintext or decrypts successfully.
 * Returns false if decryption fails (wrong key / corrupted data).
 */
export function canDecrypt(stored: string): boolean {
    if (!stored.startsWith(ENCRYPTED_PREFIX)) return true; // plaintext
    if (!aesKey || !masterKey) return false;
    try {
        decryptField(stored);
        return true;
    } catch {
        return false;
    }
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/** Concatenates multiple Uint8Arrays into one. */
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    let totalLen = 0;
    for (const arr of arrays) totalLen += arr.length;
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

/** Encodes Uint8Array to base64 string (Node.js). */
function uint8ToBase64(data: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < data.length; i++) {
        binary += String.fromCharCode(data[i] as number);
    }
    return btoa(binary);
}

/** Decodes base64 string to Uint8Array (Node.js). */
function base64ToUint8(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
