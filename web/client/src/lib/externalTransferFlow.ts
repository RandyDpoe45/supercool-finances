import type { PendingTransferView } from './transferFlow';

/**
 * The EXTERNAL-transfer wizard as a PURE state machine — no React, no network — a sibling of the
 * internal {@link transferFlowReducer}. It reuses the shared {@link PendingTransferView} and the
 * confirm/cancel/OTP machinery, but the pre-initiate journey is genuinely different, so it gets its
 * own small reducer rather than overloading the internal one:
 *
 *  - there is NO confirmation-of-payee / resolve step (the cooling-off delay is the anti-fraud gate),
 *    so the destination is a pre-enrolled payee addressed by `payeeId` chosen straight from the list;
 *  - the payee + source + amount are composed in ONE step, and a HOLD is placed at initiate.
 *
 * Journey: compose (pick a usable payee + source + amount + captcha) → initiate (PENDING, a hold is
 * placed now) → OTP confirm (settles, releasing the hold into a posted movement) or cancel (releases
 * the hold). A prior external pending discovered on mount resumes at the confirm step.
 *
 * Anything non-deterministic — the generated idempotency key, the server response — is computed by
 * the page and passed IN via the action payload, so the reducer stays deterministic and testable.
 */

export type ExternalTransferFlowState =
  /**
   * The compose step. `idempotencyKey` is fixed ONCE (when the flow starts / resets) and REUSED
   * across every initiate attempt of this logical transfer — including the "Send anyway" duplicate
   * re-submit — so a retry can never double-submit. `suspectedDuplicate` flips true when the service
   * soft-blocks an identical recent payment.
   */
  | { step: 'compose'; idempotencyKey: string; suspectedDuplicate: boolean }
  | { step: 'awaitingOtp'; transfer: PendingTransferView }
  | { step: 'posted'; transfer: PendingTransferView }
  | { step: 'cancelled' };

export type ExternalTransferFlowAction =
  /** Abandon the current flow and start over with a FRESH idempotency key (page-generated). */
  | { type: 'reset'; idempotencyKey: string }
  /** A prior pending transfer was found (on mount) — jump straight to its confirm step. */
  | { type: 'resumePending'; transfer: PendingTransferView }
  /** Initiate was soft-blocked as a suspected duplicate — offer "Send anyway". */
  | { type: 'duplicateSuspected' }
  /** Initiate succeeded — a PENDING transfer (with a hold placed) now awaits OTP confirmation. */
  | { type: 'transferInitiated'; transfer: PendingTransferView }
  /** Confirm succeeded — the transfer SETTLED (money moved, hold released). */
  | { type: 'transferPosted' }
  /** Cancel succeeded — the pending transfer is CANCELLED (hold released). */
  | { type: 'transferCancelled' };

/** Build the initial compose state with the caller-generated idempotency key (kept out of the pure
 * reducer so the key is a deliberate, page-owned value, never re-derived inside a transition). */
export function initialExternalTransferFlowState(
  idempotencyKey: string,
): ExternalTransferFlowState {
  return { step: 'compose', idempotencyKey, suspectedDuplicate: false };
}

/**
 * Advance the external flow. `reset` and `resumePending` apply from any step (a pending can surface
 * at any time); every other action is guarded to its originating step, so a stray/duplicate dispatch
 * (e.g. a double mutation callback) can never drive an illegal transition — it returns the state
 * unchanged. Critically, no transition ever regenerates the idempotency key mid-flow.
 */
export function externalTransferFlowReducer(
  state: ExternalTransferFlowState,
  action: ExternalTransferFlowAction,
): ExternalTransferFlowState {
  switch (action.type) {
    case 'reset':
      return initialExternalTransferFlowState(action.idempotencyKey);

    case 'resumePending':
      return { step: 'awaitingOtp', transfer: action.transfer };

    case 'duplicateSuspected':
      return state.step === 'compose' ? { ...state, suspectedDuplicate: true } : state;

    case 'transferInitiated':
      return state.step === 'compose' ? { step: 'awaitingOtp', transfer: action.transfer } : state;

    case 'transferPosted':
      return state.step === 'awaitingOtp' ? { step: 'posted', transfer: state.transfer } : state;

    case 'transferCancelled':
      return state.step === 'awaitingOtp' ? { step: 'cancelled' } : state;

    default:
      return state;
  }
}
