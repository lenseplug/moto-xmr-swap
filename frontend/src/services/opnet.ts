/**
 * OPNet provider singleton and contract cache for the MOTO-XMR Swap dApp.
 */
import { getContract, JSONRpcProvider, IOP20Contract, OP_20_ABI } from 'opnet';
import type { BitcoinInterfaceAbi } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { Address } from '@btc-vision/transaction';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { SwapVaultAbi } from './swap-abi';
import type { ISwapVault } from './swap-abi';

const TESTNET_RPC = 'https://testnet.opnet.org';

let providerInstance: JSONRpcProvider | null = null;

/**
 * Returns the cached testnet provider singleton.
 * Creates it on first call.
 */
export function getProvider(): JSONRpcProvider {
    if (providerInstance === null) {
        providerInstance = new JSONRpcProvider({
            url: TESTNET_RPC,
            network: networks.opnetTestnet,
        });
    }
    return providerInstance;
}

const swapVaultCache = new Map<string, ISwapVault>();
const motoTokenCache = new Map<string, IOP20Contract>();

/**
 * Returns a cached SwapVault contract instance.
 * Updates the sender on every call without recreating the instance.
 *
 * @param contractAddress - The SwapVault contract address (opt1sq... format)
 * @param sender - The OPNet Address of the connected wallet (optional for reads)
 */
export function getSwapVaultContract(contractAddress: string, sender?: Address): ISwapVault {
    const provider = getProvider();
    const cacheKey = contractAddress;

    if (!swapVaultCache.has(cacheKey)) {
        const contract = getContract<ISwapVault>(
            contractAddress,
            SwapVaultAbi as unknown as BitcoinInterfaceAbi,
            provider,
            networks.opnetTestnet,
            sender,
        );
        swapVaultCache.set(cacheKey, contract);
    }

    const cached = swapVaultCache.get(cacheKey);
    if (!cached) {
        throw new Error('Contract cache miss after set — this should not happen');
    }

    if (sender !== undefined) {
        cached.setSender(sender);
    }

    return cached;
}

/**
 * Returns a cached MOTO token (OP-20) contract instance.
 * Updates the sender on every call without recreating the instance.
 *
 * @param tokenAddress - The MOTO token contract address
 * @param sender - The OPNet Address of the connected wallet (optional for reads)
 */
export function getMotoContract(tokenAddress: string, sender?: Address): IOP20Contract {
    const provider = getProvider();
    const cacheKey = tokenAddress;

    if (!motoTokenCache.has(cacheKey)) {
        const contract = getContract<IOP20Contract>(
            tokenAddress,
            OP_20_ABI,
            provider,
            networks.opnetTestnet,
            sender,
        );
        motoTokenCache.set(cacheKey, contract);
    }

    const cached = motoTokenCache.get(cacheKey);
    if (!cached) {
        throw new Error('Contract cache miss after set — this should not happen');
    }

    if (sender !== undefined) {
        cached.setSender(sender);
    }

    return cached;
}

/**
 * Converts a raw bigint amount (18 decimals) to a human-readable string.
 *
 * @param raw - Raw token amount in smallest units
 * @param decimals - Number of decimal places (default 18)
 */
export function formatTokenAmount(raw: bigint, decimals = 18): string {
    if (raw === 0n) return '0';
    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const frac = raw % divisor;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole}.${fracStr}`;
}

/**
 * Converts a XMR amount (12 decimals, piconeroes) to display string.
 *
 * @param raw - Raw XMR amount in atomic units (12 decimals)
 */
export function formatXmrAmount(raw: bigint): string {
    if (raw === 0n) return '0';
    const divisor = 10n ** 12n;
    const whole = raw / divisor;
    const frac = raw % divisor;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
    return `${whole}.${fracStr}`;
}

/**
 * Parses a human-readable MOTO amount string to raw bigint (18 decimals).
 *
 * @param display - Display string like "100.5"
 */
export function parseMotoAmount(display: string): bigint {
    const trimmed = display.trim();
    if (!trimmed || trimmed === '') return 0n;
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') throw new Error('Invalid amount');
    const [wholeStr, fracStr = ''] = trimmed.split('.');
    const whole = BigInt(wholeStr || '0');
    const paddedFrac = fracStr.padEnd(18, '0').slice(0, 18);
    const frac = BigInt(paddedFrac);
    return whole * 10n ** 18n + frac;
}

/**
 * Parses a human-readable XMR amount string to raw bigint (12 decimals).
 *
 * @param display - Display string like "0.5"
 */
export function parseXmrAmount(display: string): bigint {
    const trimmed = display.trim();
    if (!trimmed || trimmed === '') return 0n;
    if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') return 0n;
    const [wholeStr, fracStr = ''] = trimmed.split('.');
    const whole = BigInt(wholeStr || '0');
    const paddedFrac = fracStr.padEnd(12, '0').slice(0, 12);
    const frac = BigInt(paddedFrac);
    return whole * 10n ** 12n + frac;
}

/** Base58 alphabet used by Monero addresses. */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Monero base58 encoded-block-size → decoded-byte-count mapping. */
const ENCODED_BLOCK_SIZES: Record<number, number> = {
    0: 0, 2: 1, 3: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8,
};

/**
 * Decodes a single Monero base58 block to `targetBytes` bytes.
 */
function decodeBlock(block: string, targetBytes: number): Uint8Array {
    let num = 0n;
    for (const char of block) {
        const idx = BASE58_ALPHABET.indexOf(char);
        if (idx === -1) throw new Error(`Invalid base58 character: ${char}`);
        num = num * 58n + BigInt(idx);
    }
    const out = new Uint8Array(targetBytes);
    for (let i = targetBytes - 1; i >= 0; i--) {
        out[i] = Number(num & 0xffn);
        num >>= 8n;
    }
    return out;
}

/**
 * Decodes a Monero base58 string (block-encoded) to a Uint8Array.
 * Monero splits bytes into 8-byte blocks, each encoded as 11 base58 chars,
 * with a shorter final block.
 */
function base58Decode(input: string): Uint8Array {
    const fullBlocks = Math.floor(input.length / 11);
    const lastBlockChars = input.length % 11;
    const lastBlockBytes = ENCODED_BLOCK_SIZES[lastBlockChars];

    if (lastBlockBytes === undefined) {
        throw new Error(`Invalid Monero base58 length: ${input.length}`);
    }

    const totalBytes = fullBlocks * 8 + lastBlockBytes;
    const result = new Uint8Array(totalBytes);
    let offset = 0;

    for (let i = 0; i < fullBlocks; i++) {
        const chunk = input.slice(i * 11, i * 11 + 11);
        result.set(decodeBlock(chunk, 8), offset);
        offset += 8;
    }

    if (lastBlockChars > 0) {
        const lastChunk = input.slice(fullBlocks * 11);
        result.set(decodeBlock(lastChunk, lastBlockBytes), offset);
    }

    return result;
}

/**
 * Returns true if the string looks like a hex-encoded address (only 0-9, a-f, A-F).
 */
function isHexString(s: string): boolean {
    return /^(0x)?[0-9a-fA-F]+$/.test(s);
}

/**
 * Parses a Monero address (base58 or hex) and returns the 64-byte payload
 * (32-byte spend key + 32-byte view key) as a hex string.
 *
 * Accepts:
 *  - Standard Monero address (95-char base58, starts with 4)
 *  - Monero testnet/stagenet address (95-char base58, starts with 5, 7, 9, etc.)
 *  - Raw hex (64-128 hex chars)
 */
export function parseXmrAddress(input: string): string {
    const trimmed = input.trim().replace(/^0x/, '');

    // If it looks like hex, use as-is
    if (isHexString(trimmed)) {
        return trimmed;
    }

    // Otherwise try base58 decode (standard Monero address)
    const decoded = base58Decode(trimmed);

    // Monero standard address: 1 byte network + 32 spend + 32 view + 4 checksum = 69 bytes
    // Integrated address: 1 byte network + 32 spend + 32 view + 8 payment_id + 4 checksum = 77 bytes
    if (decoded.length < 69) {
        throw new Error(`Decoded address too short: ${decoded.length} bytes (expected >= 69)`);
    }

    // Validate Keccak-256 checksum (last 4 bytes of decoded = first 4 bytes of hash(prefix + keys))
    const checksumOffset = decoded.length - 4;
    const addressPayload = decoded.slice(0, checksumOffset);
    const expectedChecksum = decoded.slice(checksumOffset);
    const actualChecksum = keccak_256(addressPayload).slice(0, 4);
    for (let i = 0; i < 4; i++) {
        if (expectedChecksum[i] !== actualChecksum[i]) {
            throw new Error('Invalid Monero address: checksum mismatch (typo in address?)');
        }
    }

    // Extract spend key (bytes 1-32) and view key (bytes 33-64)
    const payload = decoded.slice(1, 65);
    return Array.from(payload)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Encodes a Monero address (base58 or hex) as two 256-bit big-endian values
 * for on-chain storage.
 *
 * @param xmrAddress - Standard Monero address (base58) or 128-char hex
 */
export function splitXmrAddress(xmrAddress: string): { hi: bigint; lo: bigint } {
    const hex = parseXmrAddress(xmrAddress);
    const clean = hex.padStart(128, '0');
    const hi = BigInt('0x' + clean.slice(0, 64));
    const lo = BigInt('0x' + clean.slice(64, 128));
    return { hi, lo };
}

/**
 * Reconstructs a XMR address hex string from hi/lo bigint parts.
 *
 * @param hi - High 128 bits
 * @param lo - Low 128 bits
 */
export function joinXmrAddress(hi: bigint, lo: bigint): string {
    const hiStr = hi.toString(16).padStart(64, '0');
    const loStr = lo.toString(16).padStart(64, '0');
    return hiStr + loStr;
}
