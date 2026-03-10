/**
 * Crypto module — re-exports for cross-curve key operations.
 */

export {
    generateEd25519KeyPair,
    ed25519PublicFromPrivate,
    addEd25519Points,
    addEd25519Scalars,
    computeSharedMoneroAddress,
} from './keys.js';

export {
    verifyBobKeyProof,
} from './dleq.js';

export type {
    IEd25519KeyPair,
    ICrossCurveKeyPair,
    ISharedMoneroAddress,
    MoneroNetwork,
    IAliceKeyMaterial,
    IBobKeyMaterial,
} from './types.js';
