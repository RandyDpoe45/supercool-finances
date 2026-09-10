/**
 * The internal-transfer wizard as a PURE state machine — no React, no network. Keeping the
 * transitions here (the page dispatches them in response to RTK Query results) makes the flow
 * deterministic and independently testable, and keeps money-moving side effects out of the
 * reducer: anything non-deterministic (a generated idempotency key, a server response) is computed
 * by the page and passed IN via the action payload.
 *
 * Journey: resolve destination → confirm payee → amount + captcha → initiate (PENDING) →
 * OTP confirm (POSTED) or cancel. A prior pending discovered on mount resumes at the confirm step.
 */

/** A destination resolved via confirmation-of-payee, carried once the payer confirms it. */
export interface ResolvedPayee {
  accountNumber: string;
  maskedName: string;
  currency: string;
  /** Single-use, caller-bound token from `resolve-destination`; REQUIRED by initiate. */
  confirmationToken: string;
}

/**
 * A normalized view of the PENDING transfer awaiting OTP confirmation, merged from either the
 * initiate response (a `TransferDto` + the resolved payee's display) or the pending feed. Holds
 * only what the confirm step needs to render — never an internal column.
 */
export interface PendingTransferView {
  transferId: string;
  amount: string;
  currency: string;
  destinationAccountNumber: string | null;
  destinationMaskedName: string | null;
  payeeDisplayName: string | null;
  expiresAt: string | null;
}

export type TransferFlowState =
  | { step: 'resolve' }
  | { step: 'confirmPayee'; payee: ResolvedPayee }
  | { step: 'amount'; payee: ResolvedPayee; idempotencyKey: string; suspectedDuplicate: boolean }
  | { step: 'awaitingOtp'; transfer: PendingTransferView }
  | { step: 'posted'; transfer: PendingTransferView }
  | { step: 'cancelled' };

export type TransferFlowAction =
  /** Abandon the current flow and start over from the resolve step. */
  | { type: 'reset' }
  /** A prior pending transfer was found (on mount) — jump straight to its confirm step. */
  | { type: 'resumePending'; transfer: PendingTransferView }
  /** `resolve-destination` returned a payee — show it for the payer to confirm. */
  | { type: 'destinationResolved'; payee: ResolvedPayee }
  /** The payer said "not the right account" — go back to the resolve step. */
  | { type: 'payeeRejected' }
  /** The payer confirmed the payee — move to the amount step with a fresh idempotency key. */
  | { type: 'payeeConfirmed'; idempotencyKey: string }
  /** Initiate was soft-blocked as a suspected duplicate — offer "confirm anyway". */
  | { type: 'duplicateSuspected' }
  /** Initiate succeeded — a PENDING transfer now awaits OTP confirmation. */
  | { type: 'transferInitiated'; transfer: PendingTransferView }
  /** Confirm succeeded — the transfer POSTED (money moved). */
  | { type: 'transferPosted' }
  /** Cancel succeeded — the pending transfer is CANCELLED. */
  | { type: 'transferCancelled' };

export const initialTransferFlowState: TransferFlowState = { step: 'resolve' };

/**
 * Advance the flow. `reset` and `resumePending` apply from any step (a pending can surface at any
 * time); every other action is guarded to its originating step, so a stray/duplicate dispatch (e.g.
 * a double mutation callback) can never drive an illegal transition — it returns the state
 * unchanged.
 */
export function transferFlowReducer(
  state: TransferFlowState,
  action: TransferFlowAction,
): TransferFlowState {
  switch (action.type) {
    case 'reset':
      return initialTransferFlowState;

    case 'resumePending':
      return { step: 'awaitingOtp', transfer: action.transfer };

    case 'destinationResolved':
      return state.step === 'resolve' ? { step: 'confirmPayee', payee: action.payee } : state;

    case 'payeeRejected':
      return state.step === 'confirmPayee' ? initialTransferFlowState : state;

    case 'payeeConfirmed':
      return state.step === 'confirmPayee'
        ? {
            step: 'amount',
            payee: state.payee,
            idempotencyKey: action.idempotencyKey,
            suspectedDuplicate: false,
          }
        : state;

    case 'duplicateSuspected':
      return state.step === 'amount' ? { ...state, suspectedDuplicate: true } : state;

    case 'transferInitiated':
      return state.step === 'amount' ? { step: 'awaitingOtp', transfer: action.transfer } : state;

    case 'transferPosted':
      return state.step === 'awaitingOtp' ? { step: 'posted', transfer: state.transfer } : state;

    case 'transferCancelled':
      return state.step === 'awaitingOtp' ? { step: 'cancelled' } : state;

    default:
      return state;
  }
}
