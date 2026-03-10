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

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/** Prefix to identify encrypted values in the database. */
const ENCRYPTED_PREFIX = 'enc:';

let masterKey: Uint8Array | null = null;

/**
 * Initializes the encryption module with the master key from environment.
 * Must be called at startup before any encrypt/decrypt operations.
 *
 * @returns true if encryption is enabled, false if running in plaintext mode.
 */
export function initEncryption(): boolean {
    const keyHex = process.env['ENCRYPTION_KEY'] ?? '';
    if (keyHex.length === 0) {
        console.warn('[Encryption] *** WARNING *** ENCRYPTION_KEY not set. Sensitive fields stored in PLAINTEXT.');
        console.warn('[Encryption] Set ENCRYPTION_KEY (64 hex chars) for production use.');
        return false;
    }
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
        console.error('[Encryption] ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
        process.exit(1);
    }
    masterKey = hexToBytes(keyHex);
    console.log('[Encryption] Field-level encryption enabled (AES-256-GCM).');
    return true;
}

/** Returns true if encryption is active. */
export function isEncryptionEnabled(): boolean {
    return masterKey !== null;
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
    if (!masterKey) return plaintext;

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, masterKey, iv);
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
        // Not encrypted (legacy data or encryption disabled)
        return stored;
    }
    if (!masterKey) {
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

    const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
    decipher.setAuthTag(authTag);

    const part1 = decipher.update(ciphertext);
    const part2 = decipher.final();
    const decrypted = concatUint8Arrays([part1, part2]);
    return new TextDecoder().decode(decrypted);
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
