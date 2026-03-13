import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    EMPTY_POINTER,
    NetEvent,
    OP_NET,
    Revert,
    SafeMath,
    StoredMapU256,
    StoredU256,
    TransferHelper,
} from '@btc-vision/btc-runtime/runtime';
// Note: encodeSelector, @method, @returns, @emit, ABIDataTypes are compile-time globals injected by opnet-transform
import {
    ADDRESS_BYTE_LENGTH,
    U256_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime/utils';

// ── Constants ────────────────────────────────────────────────────────────────

const MIN_TIMEOUT: u256 = u256.fromU32(10);
const MAX_ACTIVE_SWAPS: u32 = 50;

// Swap status values
const STATUS_OPEN: u256 = u256.Zero;
const STATUS_TAKEN: u256 = u256.fromU32(1);
const STATUS_CLAIMED: u256 = u256.fromU32(2);
const STATUS_REFUNDED: u256 = u256.fromU32(3);

// ── Storage pointers — auto-assigned via Blockchain.nextPointer ──────────────

const PTR_NEXT_SWAP_ID:       u16 = Blockchain.nextPointer;
const PTR_TOTAL_ESCROW:       u16 = Blockchain.nextPointer;
const PTR_SWAP_HASH_LOCKS:    u16 = Blockchain.nextPointer;
const PTR_SWAP_REFUND_BLOCKS: u16 = Blockchain.nextPointer;
const PTR_SWAP_AMOUNTS:       u16 = Blockchain.nextPointer;
const PTR_SWAP_XMR_AMOUNTS:   u16 = Blockchain.nextPointer;
const PTR_SWAP_DEPOSITORS:    u16 = Blockchain.nextPointer;
const PTR_SWAP_COUNTERPARTS:  u16 = Blockchain.nextPointer;
const PTR_SWAP_STATUSES:      u16 = Blockchain.nextPointer;
const PTR_SWAP_XMR_ADDR_HI:   u16 = Blockchain.nextPointer;
const PTR_SWAP_XMR_ADDR_LO:   u16 = Blockchain.nextPointer;
const PTR_ALLOWED_TOKENS:     u16 = Blockchain.nextPointer;  // StoredMapU256: tokenAddrU256 → 1 (listed) / 0 (not)
const PTR_TOKEN_COUNT:        u16 = Blockchain.nextPointer;  // StoredU256: count of listed tokens
const PTR_SWAP_TOKEN_ADDR:    u16 = Blockchain.nextPointer;  // StoredMapU256: swapId → tokenAddress as u256

// ── Events ───────────────────────────────────────────────────────────────────

@final
class SwapCreatedEvent extends NetEvent {
    constructor(
        swapId: u256,
        depositor: Address,
        tokenAddress: Address,
        hashLock: u256,
        refundBlock: u256,
        amount: u256,
        xmrAmount: u256,
        xmrAddressHi: u256,
        xmrAddressLo: u256,
    ) {
        const data: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH * 7 + ADDRESS_BYTE_LENGTH * 2,
        );
        data.writeU256(swapId);
        data.writeAddress(depositor);
        data.writeAddress(tokenAddress);
        data.writeU256(hashLock);
        data.writeU256(refundBlock);
        data.writeU256(amount);
        data.writeU256(xmrAmount);
        data.writeU256(xmrAddressHi);
        data.writeU256(xmrAddressLo);
        super('SwapCreated', data);
    }
}

@final
class SwapTakenEvent extends NetEvent {
    constructor(swapId: u256, counterparty: Address) {
        const data: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH + ADDRESS_BYTE_LENGTH,
        );
        data.writeU256(swapId);
        data.writeAddress(counterparty);
        super('SwapTaken', data);
    }
}

@final
class SwapClaimedEvent extends NetEvent {
    constructor(swapId: u256, counterparty: Address, preimage: u256) {
        const data: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH * 2 + ADDRESS_BYTE_LENGTH,
        );
        data.writeU256(swapId);
        data.writeAddress(counterparty);
        data.writeU256(preimage);
        super('SwapClaimed', data);
    }
}

@final
class SwapRefundedEvent extends NetEvent {
    constructor(swapId: u256, depositor: Address, amount: u256) {
        const data: BytesWriter = new BytesWriter(
            U256_BYTE_LENGTH * 2 + ADDRESS_BYTE_LENGTH,
        );
        data.writeU256(swapId);
        data.writeAddress(depositor);
        data.writeU256(amount);
        super('SwapRefunded', data);
    }
}

// ── Contract ─────────────────────────────────────────────────────────────────

@final
export class SwapVault extends OP_NET {

    // Lazy-loaded storage — initialized on first access to stay under 20M gas constructor limit
    private _nextSwapId:       StoredU256    | null = null;
    private _totalEscrow:      StoredU256    | null = null;
    private _swapHashLocks:    StoredMapU256 | null = null;
    private _swapRefundBlocks: StoredMapU256 | null = null;
    private _swapAmounts:      StoredMapU256 | null = null;
    private _swapXmrAmounts:   StoredMapU256 | null = null;
    private _swapDepositors:   StoredMapU256 | null = null;
    private _swapCounterparts: StoredMapU256 | null = null;
    private _swapStatuses:     StoredMapU256 | null = null;
    private _swapXmrAddrHi:    StoredMapU256 | null = null;
    private _swapXmrAddrLo:    StoredMapU256 | null = null;
    private _allowedTokens:    StoredMapU256 | null = null;
    private _tokenCount:       StoredU256    | null = null;
    private _swapTokenAddrs:   StoredMapU256 | null = null;

    private get nextSwapId(): StoredU256 {
        if (!this._nextSwapId) this._nextSwapId = new StoredU256(PTR_NEXT_SWAP_ID, EMPTY_POINTER);
        return this._nextSwapId!;
    }

    private get totalEscrow(): StoredU256 {
        if (!this._totalEscrow) this._totalEscrow = new StoredU256(PTR_TOTAL_ESCROW, EMPTY_POINTER);
        return this._totalEscrow!;
    }

    private get swapHashLocks(): StoredMapU256 {
        if (!this._swapHashLocks) this._swapHashLocks = new StoredMapU256(PTR_SWAP_HASH_LOCKS);
        return this._swapHashLocks!;
    }

    private get swapRefundBlocks(): StoredMapU256 {
        if (!this._swapRefundBlocks) this._swapRefundBlocks = new StoredMapU256(PTR_SWAP_REFUND_BLOCKS);
        return this._swapRefundBlocks!;
    }

    private get swapAmounts(): StoredMapU256 {
        if (!this._swapAmounts) this._swapAmounts = new StoredMapU256(PTR_SWAP_AMOUNTS);
        return this._swapAmounts!;
    }

    private get swapXmrAmounts(): StoredMapU256 {
        if (!this._swapXmrAmounts) this._swapXmrAmounts = new StoredMapU256(PTR_SWAP_XMR_AMOUNTS);
        return this._swapXmrAmounts!;
    }

    private get swapDepositors(): StoredMapU256 {
        if (!this._swapDepositors) this._swapDepositors = new StoredMapU256(PTR_SWAP_DEPOSITORS);
        return this._swapDepositors!;
    }

    private get swapCounterparts(): StoredMapU256 {
        if (!this._swapCounterparts) this._swapCounterparts = new StoredMapU256(PTR_SWAP_COUNTERPARTS);
        return this._swapCounterparts!;
    }

    private get swapStatuses(): StoredMapU256 {
        if (!this._swapStatuses) this._swapStatuses = new StoredMapU256(PTR_SWAP_STATUSES);
        return this._swapStatuses!;
    }

    private get swapXmrAddrHi(): StoredMapU256 {
        if (!this._swapXmrAddrHi) this._swapXmrAddrHi = new StoredMapU256(PTR_SWAP_XMR_ADDR_HI);
        return this._swapXmrAddrHi!;
    }

    private get swapXmrAddrLo(): StoredMapU256 {
        if (!this._swapXmrAddrLo) this._swapXmrAddrLo = new StoredMapU256(PTR_SWAP_XMR_ADDR_LO);
        return this._swapXmrAddrLo!;
    }

    private get allowedTokens(): StoredMapU256 {
        if (!this._allowedTokens) this._allowedTokens = new StoredMapU256(PTR_ALLOWED_TOKENS);
        return this._allowedTokens!;
    }

    private get tokenCount(): StoredU256 {
        if (!this._tokenCount) this._tokenCount = new StoredU256(PTR_TOKEN_COUNT, EMPTY_POINTER);
        return this._tokenCount!;
    }

    private get swapTokenAddrs(): StoredMapU256 {
        if (!this._swapTokenAddrs) this._swapTokenAddrs = new StoredMapU256(PTR_SWAP_TOKEN_ADDR);
        return this._swapTokenAddrs!;
    }

    public constructor() {
        super();
        // ONLY pointer declarations and super() here — 20M gas limit
    }

    public override onDeployment(_calldata: Calldata): void {
        // Initialize nextSwapId to zero (first swap will get id 0)
        this.nextSwapId.value = u256.Zero;
        this.totalEscrow.value = u256.Zero;

        // Whitelist MOTO token on deployment
        const motoBytes = new Uint8Array(32);
        motoBytes[0]=253;motoBytes[1]=68;motoBytes[2]=115;motoBytes[3]=132;motoBytes[4]=7;motoBytes[5]=81;motoBytes[6]=213;motoBytes[7]=141;
        motoBytes[8]=159;motoBytes[9]=139;motoBytes[10]=115;motoBytes[11]=189;motoBytes[12]=213;motoBytes[13]=125;motoBytes[14]=108;motoBytes[15]=82;
        motoBytes[16]=96;motoBytes[17]=69;motoBytes[18]=61;motoBytes[19]=85;motoBytes[20]=24;motoBytes[21]=189;motoBytes[22]=124;motoBytes[23]=208;
        motoBytes[24]=45;motoBytes[25]=10;motoBytes[26]=76;motoBytes[27]=243;motoBytes[28]=223;motoBytes[29]=155;motoBytes[30]=244;motoBytes[31]=221;
        const motoAddr = Address.fromUint8Array(motoBytes);
        this.allowedTokens.set(this._addrToU256(motoAddr), u256.One);
        this.tokenCount.value = u256.One;
    }

    // ── Admin Methods ─────────────────────────────────────────────────────────

    @method({ name: 'tokenAddress', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public listToken(calldata: Calldata): BytesWriter {
        if (!Blockchain.tx.origin.equals(Blockchain.contractDeployer)) {
            throw new Revert('Only owner');
        }

        const tokenAddress = calldata.readAddress();
        const tokenKey = this._addrToU256(tokenAddress);

        // Check not already listed
        if (u256.eq(this.allowedTokens.get(tokenKey), u256.One)) {
            throw new Revert('Token already listed');
        }

        this.allowedTokens.set(tokenKey, u256.One);
        this.tokenCount.value = SafeMath.add(this.tokenCount.value, u256.One);

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method({ name: 'tokenAddress', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    public delistToken(calldata: Calldata): BytesWriter {
        if (!Blockchain.tx.origin.equals(Blockchain.contractDeployer)) {
            throw new Revert('Only owner');
        }

        const tokenAddress = calldata.readAddress();
        const tokenKey = this._addrToU256(tokenAddress);

        // Check is currently listed
        if (!u256.eq(this.allowedTokens.get(tokenKey), u256.One)) {
            throw new Revert('Token not listed');
        }

        this.allowedTokens.set(tokenKey, u256.Zero);
        this.tokenCount.value = SafeMath.sub(this.tokenCount.value, u256.One);

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ── Write Methods ─────────────────────────────────────────────────────────

    @method(
        { name: 'tokenAddress', type: ABIDataTypes.ADDRESS },
        { name: 'hashLock', type: ABIDataTypes.UINT256 },
        { name: 'refundBlock', type: ABIDataTypes.UINT256 },
        { name: 'amount', type: ABIDataTypes.UINT256 },
        { name: 'xmrAmount', type: ABIDataTypes.UINT256 },
        { name: 'xmrAddressHi', type: ABIDataTypes.UINT256 },
        { name: 'xmrAddressLo', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'swapId', type: ABIDataTypes.UINT256 })
    @emit('SwapCreated')
    public createSwap(calldata: Calldata): BytesWriter {
        // Block contract-to-contract calls on payable method
        if (!Blockchain.tx.sender.equals(Blockchain.tx.origin)) {
            throw new Revert('Direct calls only');
        }

        const tokenAddress = calldata.readAddress();
        const hashLock     = calldata.readU256();
        const refundBlock  = calldata.readU256();
        const amount       = calldata.readU256();
        const xmrAmount    = calldata.readU256();
        const xmrAddressHi = calldata.readU256();
        const xmrAddressLo = calldata.readU256();

        // Validate token is whitelisted
        if (!u256.eq(this.allowedTokens.get(this._addrToU256(tokenAddress)), u256.One)) {
            throw new Revert('Token not whitelisted');
        }

        // Validate inputs
        if (u256.eq(amount, u256.Zero)) {
            throw new Revert('Amount must be > 0');
        }
        if (u256.eq(hashLock, u256.Zero)) {
            throw new Revert('HashLock must be non-zero');
        }
        if (u256.eq(xmrAmount, u256.Zero)) {
            throw new Revert('XMR amount must be > 0');
        }

        // refundBlock must be > current block + MIN_TIMEOUT
        const minRefundBlock = SafeMath.add(Blockchain.block.numberU256, MIN_TIMEOUT);
        if (!u256.gt(refundBlock, minRefundBlock)) {
            throw new Revert('RefundBlock too soon (min +10 blocks)');
        }

        const depositor = Blockchain.tx.sender;
        const swapId    = this.nextSwapId.value;

        // Effects: write state BEFORE interaction
        this.swapHashLocks.set(swapId, hashLock);
        this.swapRefundBlocks.set(swapId, refundBlock);
        this.swapAmounts.set(swapId, amount);
        this.swapXmrAmounts.set(swapId, xmrAmount);
        this.swapDepositors.set(swapId, this._addrToU256(depositor));
        this.swapCounterparts.set(swapId, u256.Zero);
        this.swapStatuses.set(swapId, STATUS_OPEN);
        this.swapXmrAddrHi.set(swapId, xmrAddressHi);
        this.swapXmrAddrLo.set(swapId, xmrAddressLo);
        this.swapTokenAddrs.set(swapId, this._addrToU256(tokenAddress));

        this.nextSwapId.value = SafeMath.add(swapId, u256.One);
        this.totalEscrow.value = SafeMath.add(this.totalEscrow.value, amount);

        // Interaction: token transfer LAST (checks-effects-interactions)
        TransferHelper.transferFrom(tokenAddress, depositor, Blockchain.contractAddress, amount);

        this.emitEvent(new SwapCreatedEvent(
            swapId,
            depositor,
            tokenAddress,
            hashLock,
            refundBlock,
            amount,
            xmrAmount,
            xmrAddressHi,
            xmrAddressLo,
        ));

        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(swapId);
        return w;
    }

    @method({ name: 'swapId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('SwapTaken')
    public takeSwap(calldata: Calldata): BytesWriter {
        if (!Blockchain.tx.sender.equals(Blockchain.tx.origin)) {
            throw new Revert('Direct calls only');
        }

        const swapId = calldata.readU256();

        // Verify swap exists and is open
        const status = this.swapStatuses.get(swapId);
        if (!u256.eq(status, STATUS_OPEN)) {
            throw new Revert('Swap not open');
        }

        const caller    = Blockchain.tx.sender;
        const depositor = this._u256ToAddr(this.swapDepositors.get(swapId));

        // Caller cannot be the depositor
        if (caller.equals(depositor)) {
            throw new Revert('Cannot take own swap');
        }

        // Effects
        this.swapCounterparts.set(swapId, this._addrToU256(caller));
        this.swapStatuses.set(swapId, STATUS_TAKEN);

        this.emitEvent(new SwapTakenEvent(swapId, caller));

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method(
        { name: 'swapId', type: ABIDataTypes.UINT256 },
        { name: 'preimage', type: ABIDataTypes.UINT256 },
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('SwapClaimed')
    public claim(calldata: Calldata): BytesWriter {
        if (!Blockchain.tx.sender.equals(Blockchain.tx.origin)) {
            throw new Revert('Direct calls only');
        }

        const swapId  = calldata.readU256();
        const preimage = calldata.readU256();

        // Verify swap is taken
        const status = this.swapStatuses.get(swapId);
        if (!u256.eq(status, STATUS_TAKEN)) {
            throw new Revert('Swap not taken');
        }

        // Verify caller is the counterparty
        const caller       = Blockchain.tx.sender;
        const counterparty = this._u256ToAddr(this.swapCounterparts.get(swapId));
        if (!caller.equals(counterparty)) {
            throw new Revert('Not counterparty');
        }

        // Verify timelock has not expired
        const refundBlock = this.swapRefundBlocks.get(swapId);
        if (!u256.lt(Blockchain.block.numberU256, refundBlock)) {
            throw new Revert('Swap expired');
        }

        // Verify preimage matches hashLock: SHA256(preimage) == hashLock
        const preimageBytes = preimage.toUint8Array(true);
        const computedHash  = u256.fromBytes(Blockchain.sha256(preimageBytes), true);
        const hashLock      = this.swapHashLocks.get(swapId);
        if (!u256.eq(computedHash, hashLock)) {
            throw new Revert('Invalid preimage');
        }

        const amount = this.swapAmounts.get(swapId);
        const tokenAddress = this._u256ToAddr(this.swapTokenAddrs.get(swapId));

        // Effects: update state BEFORE transfer
        this.swapStatuses.set(swapId, STATUS_CLAIMED);
        this.totalEscrow.value = SafeMath.sub(this.totalEscrow.value, amount);

        // Interaction: transfer token to counterparty
        TransferHelper.transfer(tokenAddress, counterparty, amount);

        this.emitEvent(new SwapClaimedEvent(swapId, counterparty, preimage));

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    @method({ name: 'swapId', type: ABIDataTypes.UINT256 })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    @emit('SwapRefunded')
    public refund(calldata: Calldata): BytesWriter {
        if (!Blockchain.tx.sender.equals(Blockchain.tx.origin)) {
            throw new Revert('Direct calls only');
        }

        const swapId = calldata.readU256();

        // Verify status is OPEN or TAKEN (not already finalized)
        const status = this.swapStatuses.get(swapId);
        if (u256.eq(status, STATUS_CLAIMED) || u256.eq(status, STATUS_REFUNDED)) {
            throw new Revert('Swap already finalized');
        }

        // Verify timelock has expired
        const refundBlock = this.swapRefundBlocks.get(swapId);
        if (u256.lt(Blockchain.block.numberU256, refundBlock)) {
            throw new Revert('Timelock not expired');
        }

        // Verify caller is the depositor
        const caller    = Blockchain.tx.sender;
        const depositor = this._u256ToAddr(this.swapDepositors.get(swapId));
        if (!caller.equals(depositor)) {
            throw new Revert('Not depositor');
        }

        const amount = this.swapAmounts.get(swapId);
        const tokenAddress = this._u256ToAddr(this.swapTokenAddrs.get(swapId));

        // Effects: update state BEFORE transfer
        this.swapStatuses.set(swapId, STATUS_REFUNDED);
        this.totalEscrow.value = SafeMath.sub(this.totalEscrow.value, amount);

        // Interaction: transfer token back to depositor
        TransferHelper.transfer(tokenAddress, depositor, amount);

        this.emitEvent(new SwapRefundedEvent(swapId, depositor, amount));

        const w = new BytesWriter(1);
        w.writeBoolean(true);
        return w;
    }

    // ── Read Methods ──────────────────────────────────────────────────────────

    @method({ name: 'swapId', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'tokenAddress', type: ABIDataTypes.ADDRESS },
        { name: 'hashLock',     type: ABIDataTypes.UINT256 },
        { name: 'refundBlock',  type: ABIDataTypes.UINT256 },
        { name: 'amount',       type: ABIDataTypes.UINT256 },
        { name: 'xmrAmount',    type: ABIDataTypes.UINT256 },
        { name: 'depositor',    type: ABIDataTypes.ADDRESS },
        { name: 'counterparty', type: ABIDataTypes.ADDRESS },
        { name: 'status',       type: ABIDataTypes.UINT256 },
        { name: 'xmrAddressHi', type: ABIDataTypes.UINT256 },
        { name: 'xmrAddressLo', type: ABIDataTypes.UINT256 },
    )
    public getSwap(calldata: Calldata): BytesWriter {
        const swapId = calldata.readU256();

        // 7x u256 (224 bytes) + 3x address (96 bytes) = 320 bytes
        const w = new BytesWriter(U256_BYTE_LENGTH * 7 + ADDRESS_BYTE_LENGTH * 3);
        w.writeAddress(this._u256ToAddr(this.swapTokenAddrs.get(swapId)));
        w.writeU256(this.swapHashLocks.get(swapId));
        w.writeU256(this.swapRefundBlocks.get(swapId));
        w.writeU256(this.swapAmounts.get(swapId));
        w.writeU256(this.swapXmrAmounts.get(swapId));
        w.writeAddress(this._u256ToAddr(this.swapDepositors.get(swapId)));
        w.writeAddress(this._u256ToAddr(this.swapCounterparts.get(swapId)));
        w.writeU256(this.swapStatuses.get(swapId));
        w.writeU256(this.swapXmrAddrHi.get(swapId));
        w.writeU256(this.swapXmrAddrLo.get(swapId));
        return w;
    }

    @method()
    @returns({ name: 'swapIds', type: ABIDataTypes.UINT256_ARRAY })
    public getActiveSwaps(_calldata: Calldata): BytesWriter {
        const total = this.nextSwapId.value;
        const maxU  = u256.fromU32(MAX_ACTIVE_SWAPS);

        // Scan the most recent MAX_ACTIVE_SWAPS swap IDs (not always 0..49)
        // start = max(0, total - MAX_ACTIVE_SWAPS)
        const start: u256 = u256.gt(total, maxU) ? SafeMath.sub(total, maxU) : u256.Zero;

        // Number of IDs to check: min(total, MAX_ACTIVE_SWAPS)
        const scanCount = u256.lt(total, maxU) ? total : maxU;
        const scanU32: u32 = <u32>scanCount.lo1;

        // Collect active (OPEN or TAKEN) swap IDs
        const activeIds: u256[] = [];
        for (let i: u32 = 0; i < scanU32; i++) {
            const id     = SafeMath.add(start, u256.fromU32(i));
            const status = this.swapStatuses.get(id);
            if (u256.eq(status, STATUS_OPEN) || u256.eq(status, STATUS_TAKEN)) {
                activeIds.push(id);
            }
        }

        // Write: count (u32 = 4 bytes) + each id (32 bytes each)
        const count = activeIds.length;
        const w = new BytesWriter(4 + count * U256_BYTE_LENGTH);
        w.writeU32(count);
        for (let i = 0; i < count; i++) {
            w.writeU256(activeIds[i]);
        }
        return w;
    }

    @method()
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getSwapCount(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(this.nextSwapId.value);
        return w;
    }

    @method()
    @returns({ name: 'totalEscrow', type: ABIDataTypes.UINT256 })
    public getTotalEscrow(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(this.totalEscrow.value);
        return w;
    }

    @method({ name: 'tokenAddress', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'listed', type: ABIDataTypes.BOOL })
    public isListed(calldata: Calldata): BytesWriter {
        const tokenAddress = calldata.readAddress();
        const listed = u256.eq(this.allowedTokens.get(this._addrToU256(tokenAddress)), u256.One);
        const w = new BytesWriter(1);
        w.writeBoolean(listed);
        return w;
    }

    @method()
    @returns({ name: 'count', type: ABIDataTypes.UINT256 })
    public getTokenCount(_calldata: Calldata): BytesWriter {
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(this.tokenCount.value);
        return w;
    }

    // ── Private Helpers ───────────────────────────────────────────────────────

    private _addrToU256(addr: Address): u256 {
        const tmp = new Uint8Array(32);
        memory.copy(tmp.dataStart, addr.dataStart, 32);
        return u256.fromBytes(tmp, true);
    }

    private _u256ToAddr(val: u256): Address {
        return Address.fromUint8Array(val.toUint8Array(true));
    }
}
