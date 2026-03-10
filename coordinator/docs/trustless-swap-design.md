# Trustless MOTO-XMR Swap: Sidecar Integration Design

## Status: V1 Design (Sidecar) — Draft

## Executive Summary

This document describes how to make the MOTO-XMR swap trustless by eliminating
the coordinator as a trusted custodian of XMR. The key insight is that we can
**use the Monero key share as the HTLC preimage**, creating a cryptographic link
between the OPNet HTLC and the Monero split-key wallet. No changes to the
existing OPNet SwapVault contract are required.

## Problem Statement

Currently, the coordinator is a fully trusted custodian:
- It holds the Monero wallet keys
- It controls when/whether to reveal the preimage
- It could front-run claims, withhold secrets, or redirect XMR

The MOTO side has a real HTLC (hash lock + time lock), but the XMR side has
no atomic guarantee. Bob must trust the coordinator.

## Solution: Hash-Preimage-as-Monero-Key

### Core Concept

Instead of generating a random preimage and a separate Monero key:

1. Alice generates a **Monero key share** `s_a` (32-byte scalar on ed25519)
2. The **SHA-256 hash of `s_a`** becomes the hash lock for the OPNet HTLC
3. Bob generates his own Monero key share `s_b`
4. XMR is locked to a shared address derived from `S_a_xmr + S_b_xmr`
5. When Alice claims MOTO on-chain (revealing `s_a`), Bob reads `s_a` from
   the OPNet calldata and computes the full Monero spend key `s = s_a + s_b`
6. Bob sweeps the XMR

This makes the swap **atomic**: claiming MOTO necessarily reveals the secret
needed to spend XMR.

### Why This Works

- The OPNet HTLC contract already verifies `SHA256(preimage) == hash_lock`
- We just make the preimage meaningful: it's Alice's Monero key share
- No contract changes needed — the contract doesn't know or care what the
  preimage represents
- The cryptographic link ensures atomicity: you can't claim MOTO without
  revealing the Monero key share

## Protocol Flow

### Roles
- **Alice** = MOTO depositor (wants XMR)
- **Bob** = XMR sender (wants MOTO)
- **Coordinator** = orchestrator (no longer trusted with secrets)

### Happy Path

```
Alice                     Coordinator                    Bob
  |                            |                           |
  | 1. Generate s_a, s_b_xmr  |                           |
  |    hash = SHA256(s_a)      |                           |
  |                            |                           |
  | 2. Create HTLC on OPNet   |                           |
  |    (hash_lock = hash)      |                           |
  |--------------------------->|                           |
  |                            |                           |
  | 3. Submit s_a to coord     |                           |
  |    + Alice's XMR pubkey    |                           |
  |--------------------------->|                           |
  |                            |                           |
  |                            | 4. Verify SHA256(s_a)     |
  |                            |    == hash_lock            |
  |                            |                           |
  |                            |<----- 5. Bob takes swap --|
  |                            |       + submits S_b_xmr   |
  |                            |       + DLEQ proof        |
  |                            |                           |
  |                            | 6. Verify Bob's DLEQ     |
  |                            |    Compute shared addr:   |
  |                            |    S = S_a_xmr + S_b_xmr |
  |                            |    V = v_a + v_b          |
  |                            |                           |
  |                            | 7. Return XMR lock addr  |
  |                            |    + expected amount      |
  |                            |-------------------------->|
  |                            |                           |
  |                            |      8. Bob sends XMR --->|
  |                            |         to shared addr    |
  |                            |                           |
  |                            | 9. Monitor XMR confirms   |
  |                            |    (10 confirmations)     |
  |                            |                           |
  |                            | 10. XMR confirmed!        |
  |                            |     Reveal s_a to Bob     |
  |                            |     via WebSocket         |
  |                            |-------------------------->|
  |                            |                           |
  |                            |  11. Bob claims MOTO ---->|
  |                            |      on OPNet with s_a    |
  |                            |      (preimage = s_a)     |
  |                            |                           |
  |                            |  12. Bob reads s_a from   |
  |                            |      on-chain calldata    |
  |                            |      spend_key = s_a + s_b|
  |                            |      Sweeps XMR           |
  |                            |                           |
```

### Refund Path (Alice reclaims MOTO)

If Bob never sends XMR, or the swap times out:
1. The HTLC timelock expires
2. Alice refunds her MOTO on-chain
3. No XMR was sent, so nothing to recover
4. If XMR WAS sent but not enough confirmations: the XMR is in a shared
   address that Bob can recover once Alice refunds (since Alice never
   revealed s_a, Bob still has s_b and can wait for Alice to eventually
   reveal s_a in another context, OR the XMR is effectively frozen)

### Safety Analysis

| Scenario | Outcome | Safe? |
|----------|---------|-------|
| Happy path | Alice gets XMR, Bob gets MOTO | Yes |
| Bob never sends XMR | Alice refunds MOTO after timeout | Yes |
| Bob sends insufficient XMR | Coordinator rejects, Alice refunds | Yes |
| Alice tries to claim without XMR confirmed | Coordinator withholds s_a | Yes* |
| Coordinator goes offline | s_a is already submitted, Bob has it from WS | Partial |
| Coordinator colludes with Alice | Cannot steal — Bob needs s_a from on-chain claim | Yes |

*The coordinator still acts as a timing gate (won't reveal preimage until XMR
is confirmed), but it cannot steal funds because:
- It doesn't know s_b (only Bob does)
- It can't spend the XMR alone
- If it reveals s_a early, Bob can claim MOTO AND sweep XMR

### Remaining Trust Assumptions

1. **Coordinator must reveal s_a after XMR confirms** — if it withholds s_a
   indefinitely, Bob's XMR is locked and he can't claim MOTO. Mitigation:
   Alice can claim MOTO on-chain directly (she knows s_a), which reveals it
   publicly. The coordinator is just a convenience, not a gatekeeper.

2. **DLEQ proof verification** — we need to verify that Bob's ed25519 and
   secp256k1 keys share the same discrete log. Without this, Bob could
   provide a fake XMR key that doesn't correspond to a real Monero address.

3. **Monero shared address correctness** — the coordinator computes the
   shared address. If it computes it wrong, XMR could be lost. Mitigation:
   Bob should independently verify the shared address before sending XMR.

## Architecture

### V1: Sidecar Model (This Design)

```
┌──────────────────────────────────────────────────────┐
│ Coordinator (Node.js)                                │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ HTTP Server  │  │ WebSocket    │  │ OPNet      │  │
│  │ (REST API)   │  │ Server       │  │ Watcher    │  │
│  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │
│         │                 │                │         │
│  ┌──────┴─────────────────┴────────────────┴──────┐  │
│  │              Swap Orchestrator                  │  │
│  │  (state machine, XMR locking, key management)  │  │
│  └──────────────────────┬─────────────────────────┘  │
│                         │                            │
│  ┌──────────────────────┴─────────────────────────┐  │
│  │           Monero Module (IMoneroService)        │  │
│  │                                                 │  │
│  │  ┌─────────────────┐  ┌──────────────────────┐ │  │
│  │  │ TrustlessMonero │  │ CustodialMonero      │ │  │
│  │  │ Service (V1)    │  │ Service (existing)   │ │  │
│  │  │                 │  │                      │ │  │
│  │  │ - Split keys    │  │ - Single wallet      │ │  │
│  │  │ - DLEQ verify   │  │ - Mock or Real RPC   │ │  │
│  │  │ - Shared addrs  │  │                      │ │  │
│  │  └─────────────────┘  └──────────────────────┘ │  │
│  └─────────────────────────────────────────────────┘  │
│                         │                            │
│  ┌──────────────────────┴─────────────────────────┐  │
│  │           Crypto Module (new)                   │  │
│  │                                                 │  │
│  │  - ed25519 key generation (via @noble/curves)   │  │
│  │  - Cross-curve DLEQ proof verification          │  │
│  │    (via dleq-tools WASM)                        │  │
│  │  - Shared Monero address computation            │  │
│  └─────────────────────────────────────────────────┘  │
│                         │                            │
│  ┌──────────────────────┴─────────────────────────┐  │
│  │           monero-wallet-rpc (existing)          │  │
│  │  - Transfer to shared address                   │  │
│  │  - Monitor confirmations                        │  │
│  │  - Sweep with reconstructed key                 │  │
│  └─────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### New Dependencies

| Package | Purpose | Maturity |
|---------|---------|----------|
| `@noble/curves` | ed25519 + secp256k1 operations | Audited, mature |
| `@noble/hashes` | SHA-256 (already used) | Audited, mature |
| `dleq-tools` | Cross-curve DLEQ proof verification (WASM) | v0.2.0, experimental |

### Key Decision: DLEQ Proof Verification

For V1, we have two options for DLEQ verification:

**Option A: Use `dleq-tools` WASM package (recommended for V1)**
- Pros: Ready-made, handles cross-curve math
- Cons: Experimental (v0.2.0), WASM dependency
- Risk: If the proof system has bugs, Bob could provide fake keys

**Option B: Implement using `@noble/curves` directly**
- Pros: No WASM, audited library
- Cons: Must implement the bit-decomposition DLEQ ourselves (complex)
- Risk: Implementation bugs in novel crypto code

**Option C: Skip DLEQ for V1, verify via coordinator observation**
- Pros: Simplest to implement
- Cons: Trust assumption — coordinator must verify XMR address correctness
- Risk: If coordinator is compromised, it could approve bad addresses

**Recommendation**: Option A for V1 (use `dleq-tools`), with a fallback to
Option C if `dleq-tools` has integration issues. Option B for V2.

## Implementation Plan

### Phase 1: Crypto Module

New file: `coordinator/src/crypto/index.ts`

```typescript
// Key types
interface IEd25519KeyPair {
    privateKey: Uint8Array;  // 32 bytes
    publicKey: Uint8Array;   // 32 bytes
}

interface ICrossKeyPair {
    ed25519: IEd25519KeyPair;
    secp256k1PublicKey: Uint8Array;  // 33 bytes (compressed)
    dleqProof: Uint8Array;
}

interface ISharedMoneroAddress {
    address: string;          // Monero address string
    publicSpendKey: Uint8Array;  // S_a + S_b on ed25519
    publicViewKey: Uint8Array;   // V_a + V_b on ed25519
}

// Functions
function generateCrossKeyPair(): ICrossKeyPair;
function verifyDleqProof(
    ed25519Point: Uint8Array,
    secp256k1Point: Uint8Array,
    proof: Uint8Array,
): boolean;
function computeSharedMoneroAddress(
    aliceEd25519Pub: Uint8Array,
    bobEd25519Pub: Uint8Array,
    aliceViewKey: Uint8Array,
    bobViewKey: Uint8Array,
    network: 'mainnet' | 'stagenet',
): ISharedMoneroAddress;
function reconstructSpendKey(
    alicePrivateKey: Uint8Array,
    bobPrivateKey: Uint8Array,
): Uint8Array;
```

### Phase 2: New API Endpoints

#### POST /api/swaps/:id/take-trustless

Bob's enhanced take endpoint:

```json
{
    "opnetTxId": "abc123...",
    "bobEd25519PubKey": "hex...",
    "bobSecp256k1PubKey": "hex...",
    "bobDleqProof": "hex...",
    "bobViewKey": "hex..."
}
```

Response includes the shared XMR lock address.

#### POST /api/swaps/:id/secret (modified)

Alice's secret submission now also includes her ed25519 public key and
DLEQ proof:

```json
{
    "secret": "hex...",           // s_a (64 hex chars)
    "aliceEd25519PubKey": "hex...",
    "aliceDleqProof": "hex...",
    "aliceViewKey": "hex..."
}
```

### Phase 3: Database Schema Changes

New columns on `swaps` table:

```sql
ALTER TABLE swaps ADD COLUMN alice_ed25519_pub TEXT;
ALTER TABLE swaps ADD COLUMN bob_ed25519_pub TEXT;
ALTER TABLE swaps ADD COLUMN alice_view_key TEXT;
ALTER TABLE swaps ADD COLUMN bob_view_key TEXT;
ALTER TABLE swaps ADD COLUMN shared_spend_key TEXT;  -- computed, for recovery
ALTER TABLE swaps ADD COLUMN trustless_mode INTEGER DEFAULT 0;
```

### Phase 4: TrustlessMoneroService

New `IMoneroService` implementation:

```typescript
class TrustlessMoneroService implements IMoneroService {
    // Instead of creating a subaddress, computes a shared address
    // from Alice's and Bob's ed25519 public keys
    async createLockAddress(swapId: string): Promise<ILockAddressResult> {
        const swap = this.storage.getSwap(swapId);
        // Compute shared address from stored keys
        const shared = computeSharedMoneroAddress(
            swap.alice_ed25519_pub,
            swap.bob_ed25519_pub,
            swap.alice_view_key,
            swap.bob_view_key,
            this.network,
        );
        return { address: shared.address, subaddrIndex: -1 };
    }

    // Monitoring works the same — poll monero-wallet-rpc for
    // incoming transfers to the shared address
    startMonitoring(...) { /* same as RealMoneroService */ }
}
```

### Phase 5: Frontend Changes

The frontend needs to:
1. Generate Bob's cross-curve key pair (in-browser)
2. Submit keys + DLEQ proof when taking a swap
3. After receiving s_a (preimage), compute the full Monero spend key
4. Display the Monero sweep key for Bob to import into his wallet

New frontend dependency: `@noble/curves` (already small, tree-shakeable)

### Phase 6: Backward Compatibility

The system supports both modes:

```typescript
const TRUSTLESS_MODE = process.env['TRUSTLESS_MODE'] ?? 'false';

function createMoneroService(): IMoneroService {
    if (TRUSTLESS_MODE === 'true') {
        return new TrustlessMoneroService();
    }
    // Existing custodial mode
    const useMock = process.env['MONERO_MOCK'] === 'true';
    return useMock ? new MockMoneroService() : new RealMoneroService();
}
```

## State Machine Changes

No new states needed. The existing state machine works:

```
OPEN → TAKEN → XMR_LOCKING → XMR_LOCKED → COMPLETED
                                        → REFUNDED
```

The difference is what happens at each transition:

| State | Custodial Mode (current) | Trustless Mode (V1) |
|-------|-------------------------|---------------------|
| OPEN | Random preimage generated | s_a generated as preimage |
| TAKEN | Coordinator creates subaddr | Coordinator computes shared addr from key shares |
| XMR_LOCKING | Bob sends to subaddr | Bob sends to shared addr |
| XMR_LOCKED | Coordinator reveals preimage | Coordinator reveals s_a (same thing) |
| COMPLETED | Bob claims with preimage | Bob claims with s_a, then computes s_a+s_b to sweep XMR |

## Security Considerations

### What the Coordinator Can No Longer Do

1. **Steal XMR** — it doesn't know s_b, so it can't compute the full spend key
2. **Front-run claims** — even if it claims MOTO first, Bob can read s_a from
   the chain and still sweep XMR
3. **Withhold preimage** — Alice can claim on-chain herself (she knows s_a)

### What the Coordinator CAN Still Do

1. **Deny service** — refuse to generate the shared address or stop monitoring
2. **Delay** — slow down XMR confirmation monitoring
3. **Compute the shared address wrong** — but Bob should verify independently

### Remaining Attack Vectors

1. **Bob provides fake DLEQ proof** — if DLEQ verification is buggy, Bob could
   provide an ed25519 key that doesn't correspond to a real Monero address.
   XMR would be sent to an unspendable address. Mitigation: rigorous DLEQ
   verification using audited libraries.

2. **Coordinator computes wrong shared address** — Bob should independently
   verify the shared address matches his expectations (he knows both public
   keys). The frontend should do this verification.

3. **Race condition on s_a revelation** — if the coordinator reveals s_a via
   WebSocket and a malicious observer intercepts it, they could front-run
   Bob's MOTO claim. But they can't sweep XMR (they don't know s_b). And
   Bob can still claim MOTO since the preimage is public once used on-chain.

## V2 Roadmap (Hybrid Model)

V2 would extend this design by:

1. **Removing the coordinator's Monero wallet** — Bob and Alice communicate
   key shares directly (peer-to-peer or via the coordinator as a relay)
2. **Adding the punishment mechanism** — if Bob abandons after XMR is locked,
   Alice should be able to recover. This requires a more complex OPNet
   contract with cancel/punish paths.
3. **Full adaptor signature integration** — replace the hash-based HTLC with
   adaptor signatures for privacy (no shared hash on-chain)

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `coordinator/src/crypto/index.ts` | **Create** | Ed25519 keys, DLEQ verification, shared address computation |
| `coordinator/src/crypto/dleq.ts` | **Create** | DLEQ proof verification wrapper (dleq-tools WASM) |
| `coordinator/src/trustless-monero.ts` | **Create** | TrustlessMoneroService implementation |
| `coordinator/src/monero-module.ts` | Modify | Add factory option for trustless mode |
| `coordinator/src/types.ts` | Modify | Add trustless fields to ISwapRecord, ICreateSwapParams |
| `coordinator/src/storage.ts` | Modify | Migration for new columns |
| `coordinator/src/routes/swaps.ts` | Modify | Enhanced take endpoint, secret endpoint |
| `coordinator/src/index.ts` | Modify | Wire trustless mode |
| `frontend/src/services/coordinator.ts` | Modify | Submit keys with take |
| `frontend/src/components/TakeSwap.tsx` | Modify | Generate keys, verify shared address |
| `frontend/src/components/SwapStatus.tsx` | Modify | Show sweep key after completion |
| `frontend/src/crypto/keys.ts` | **Create** | Browser-side ed25519 + DLEQ |

## Open Questions for User

1. Should V1 require DLEQ proofs or trust the coordinator to verify keys?
2. Should the frontend compute the Monero sweep key, or just display s_a
   for the user to manually combine with s_b in their Monero wallet?
3. What Monero network to target? Stagenet for testing, mainnet for production?
4. Should the existing custodial mode be preserved as a fallback, or should
   V1 completely replace it?
