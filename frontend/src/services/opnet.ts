/**
 * OPNet provider singleton and contract cache for the MOTO-XMR Swap dApp.
 */
import { getContract, JSONRpcProvider, IOP20Contract, OP_20_ABI } from 'opnet';
import type { BitcoinInterfaceAbi } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { Address } from '@btc-vision/transaction';
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
    const [wholeStr, fracStr = ''] = trimmed.split('.');
    const whole = BigInt(wholeStr || '0');
    const paddedFrac = fracStr.padEnd(12, '0').slice(0, 12);
    const frac = BigInt(paddedFrac);
    return whole * 10n ** 12n + frac;
}

/**
 * Encodes a 128-bit XMR address (Monero address) as two 128-bit big-endian chunks.
 * Monero addresses are 128 bytes total (256 bits → split into hi/lo 128-bit parts).
 *
 * @param xmrAddressHex - 64-char hex string (256-bit XMR address)
 */
export function splitXmrAddress(xmrAddressHex: string): { hi: bigint; lo: bigint } {
    // Monero addresses are 64 bytes (128 hex chars). Pad to full 128-char width
    // then split into two 256-bit (64-char) halves.
    const clean = xmrAddressHex.replace(/^0x/, '').padStart(128, '0');
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
