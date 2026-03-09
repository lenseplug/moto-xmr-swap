/**
 * Swap state machine — typed transitions with guards.
 */

import { type ISwapRecord, SwapStatus, TERMINAL_STATES } from './types.js';

/** A state change callback invoked after every successful transition. */
export type StateChangeCallback = (swap: ISwapRecord, from: SwapStatus, to: SwapStatus) => void;

/** Maps each state to the set of states it can transition into. */
const VALID_TRANSITIONS: ReadonlyMap<SwapStatus, ReadonlySet<SwapStatus>> = new Map([
    [
        SwapStatus.OPEN,
        new Set([SwapStatus.TAKEN, SwapStatus.EXPIRED]),
    ],
    [
        SwapStatus.TAKEN,
        new Set([SwapStatus.XMR_LOCKING, SwapStatus.EXPIRED]),
    ],
    [
        SwapStatus.XMR_LOCKING,
        new Set([SwapStatus.XMR_LOCKED, SwapStatus.EXPIRED]),
    ],
    [
        SwapStatus.XMR_LOCKED,
        new Set([SwapStatus.MOTO_CLAIMING, SwapStatus.EXPIRED]),
    ],
    [
        SwapStatus.MOTO_CLAIMING,
        new Set([SwapStatus.COMPLETED]),
    ],
    [
        SwapStatus.EXPIRED,
        new Set([SwapStatus.REFUNDED]),
    ],
    [SwapStatus.COMPLETED, new Set<SwapStatus>()],
    [SwapStatus.REFUNDED, new Set<SwapStatus>()],
]);

/** Error thrown when a transition is invalid. */
export class InvalidTransitionError extends Error {
    public constructor(from: SwapStatus, to: SwapStatus) {
        super(`Invalid transition: ${from} → ${to}`);
        this.name = 'InvalidTransitionError';
    }
}

/** Error thrown when a transition guard rejects the transition. */
export class TransitionGuardError extends Error {
    public constructor(reason: string) {
        super(`Transition guard failed: ${reason}`);
        this.name = 'TransitionGuardError';
    }
}

/**
 * Validates and executes state transitions for swaps.
 * Does not persist state — the caller is responsible for storage.
 */
export class SwapStateMachine {
    private readonly callbacks: StateChangeCallback[] = [];

    /**
     * Registers a callback to be invoked on every successful state transition.
     * @param cb - The callback function.
     */
    public onStateChange(cb: StateChangeCallback): void {
        this.callbacks.push(cb);
    }

    /**
     * Checks whether a given transition is allowed by the state machine rules.
     * @param from - Current state.
     * @param to - Desired next state.
     */
    public canTransition(from: SwapStatus, to: SwapStatus): boolean {
        const allowed = VALID_TRANSITIONS.get(from);
        return allowed !== undefined && allowed.has(to);
    }

    /**
     * Validates that the transition from the current state to the target state
     * is allowed, applying any precondition guards.
     *
     * @param swap - The current swap record.
     * @param to - The desired next state.
     * @throws {InvalidTransitionError} if the transition is not in the valid map.
     * @throws {TransitionGuardError} if a precondition is not met.
     */
    public validate(swap: ISwapRecord, to: SwapStatus): void {
        if (!this.canTransition(swap.status, to)) {
            throw new InvalidTransitionError(swap.status, to);
        }
        this.runGuards(swap, to);
    }

    /**
     * Notifies all registered callbacks that a transition has occurred.
     * @param swap - The updated swap record (post-transition state).
     * @param from - The previous state.
     * @param to - The new state.
     */
    public notifyTransition(swap: ISwapRecord, from: SwapStatus, to: SwapStatus): void {
        for (const cb of this.callbacks) {
            try {
                cb(swap, from, to);
            } catch (err: unknown) {
                if (err instanceof Error) {
                    console.error(`State change callback error: ${err.message}`);
                }
            }
        }
    }

    /**
     * Determines whether a swap has reached a terminal state.
     * @param status - The status to check.
     */
    public isTerminal(status: SwapStatus): boolean {
        return TERMINAL_STATES.has(status);
    }

    private runGuards(swap: ISwapRecord, to: SwapStatus): void {
        switch (to) {
            case SwapStatus.TAKEN:
                if (!swap.counterparty) {
                    throw new TransitionGuardError(
                        'counterparty must be set before transitioning to TAKEN',
                    );
                }
                break;

            case SwapStatus.XMR_LOCKING:
                if (!swap.counterparty) {
                    throw new TransitionGuardError(
                        'counterparty must be set before XMR_LOCKING',
                    );
                }
                if (!swap.xmr_lock_tx) {
                    throw new TransitionGuardError(
                        'xmr_lock_tx must be set before XMR_LOCKING',
                    );
                }
                break;

            case SwapStatus.XMR_LOCKED:
                if (swap.xmr_lock_confirmations < 10) {
                    throw new TransitionGuardError(
                        `XMR lock needs at least 10 confirmations, got ${swap.xmr_lock_confirmations}`,
                    );
                }
                break;

            case SwapStatus.MOTO_CLAIMING:
                if (!swap.preimage) {
                    throw new TransitionGuardError(
                        'preimage must be known before MOTO_CLAIMING',
                    );
                }
                break;

            case SwapStatus.COMPLETED:
                if (!swap.opnet_claim_tx) {
                    throw new TransitionGuardError(
                        'opnet_claim_tx must be set before COMPLETED',
                    );
                }
                break;

            case SwapStatus.REFUNDED:
                if (!swap.opnet_refund_tx) {
                    throw new TransitionGuardError(
                        'opnet_refund_tx must be set before REFUNDED',
                    );
                }
                break;

            default:
                break;
        }
    }
}
