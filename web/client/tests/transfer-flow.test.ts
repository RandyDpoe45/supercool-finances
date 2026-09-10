import { describe, expect, it } from 'vitest';
import {
  initialTransferFlowState,
  transferFlowReducer,
  type PendingTransferView,
  type ResolvedPayee,
  type TransferFlowState,
} from '../src/lib/transferFlow';

/**
 * The transfer wizard reducer is the deterministic heart of the money-moving flow, so it gets the
 * sharpest tests. Correctness properties proven here (from spec 04 Transfers + docs/README):
 *
 *  - the journey advances through the intended steps and each step carries the right payload;
 *  - the `confirmationToken` from resolve threads intact into the amount step (which the page sends
 *    to initiate), and a FRESH resolve replaces a stale token;
 *  - IDEMPOTENCY-KEY STABILITY: the key is fixed once at payee-confirmation and survives the
 *    duplicate-suspected branch byte-for-byte, and a stray repeat confirm can NOT regenerate it — a
 *    regenerated key would let one logical transfer double-submit (double-spend), so those are hard
 *    failures here;
 *  - every non-resume/non-reset action is guarded to its originating step: a stray/duplicate
 *    dispatch is a no-op, never an illegal transition.
 *
 * Nothing is mocked — the reducer is pure — so a broken guard, a mis-threaded token, or a
 * regenerated key all fail.
 */

function payee(overrides: Partial<ResolvedPayee> = {}): ResolvedPayee {
  return {
    accountNumber: '2000000001',
    maskedName: 'Mar** Góm**',
    currency: 'MXN',
    confirmationToken: 'token-A',
    ...overrides,
  };
}

function pendingView(overrides: Partial<PendingTransferView> = {}): PendingTransferView {
  return {
    transferId: 'aaaaaaaa-0000-4000-8000-000000000001',
    amount: '10050',
    currency: 'MXN',
    destinationAccountNumber: '2000000001',
    destinationMaskedName: 'Mar** Góm**',
    payeeDisplayName: null,
    expiresAt: '2026-09-10T00:02:00.000Z',
    ...overrides,
  };
}

/** Advance through a list of actions from a start state (defaults to the initial state). */
function drive(
  actions: Parameters<typeof transferFlowReducer>[1][],
  start: TransferFlowState = initialTransferFlowState,
): TransferFlowState {
  return actions.reduce((state, action) => transferFlowReducer(state, action), start);
}

describe('transferFlowReducer — the happy journey', () => {
  it('starts at the resolve step', () => {
    expect(initialTransferFlowState).toEqual({ step: 'resolve' });
  });

  it('walks resolve → confirmPayee → amount → awaitingOtp → posted with the right payloads', () => {
    const p = payee();
    const confirm = drive([{ type: 'destinationResolved', payee: p }]);
    expect(confirm).toEqual({ step: 'confirmPayee', payee: p });

    const amount = transferFlowReducer(confirm, {
      type: 'payeeConfirmed',
      idempotencyKey: 'idem-1',
    });
    expect(amount).toEqual({
      step: 'amount',
      payee: p,
      idempotencyKey: 'idem-1',
      suspectedDuplicate: false,
    });

    const view = pendingView();
    const otp = transferFlowReducer(amount, { type: 'transferInitiated', transfer: view });
    expect(otp).toEqual({ step: 'awaitingOtp', transfer: view });

    const posted = transferFlowReducer(otp, { type: 'transferPosted' });
    // POSTED must carry the SAME pending view forward (so the receipt shows what was sent).
    expect(posted).toEqual({ step: 'posted', transfer: view });
  });

  it('cancels from the confirm step to the cancelled terminal', () => {
    const otp: TransferFlowState = { step: 'awaitingOtp', transfer: pendingView() };
    expect(transferFlowReducer(otp, { type: 'transferCancelled' })).toEqual({ step: 'cancelled' });
  });

  it('rejecting the payee returns to a clean resolve step (payee dropped)', () => {
    const confirm = drive([{ type: 'destinationResolved', payee: payee() }]);
    expect(transferFlowReducer(confirm, { type: 'payeeRejected' })).toEqual({ step: 'resolve' });
  });
});

describe('transferFlowReducer — confirmation-token threading + stale-token invalidation', () => {
  it('threads the resolve token intact into the amount step', () => {
    const end = drive([
      { type: 'destinationResolved', payee: payee({ confirmationToken: 'tok-live' }) },
      { type: 'payeeConfirmed', idempotencyKey: 'idem-1' },
    ]);
    expect(end.step).toBe('amount');
    if (end.step === 'amount') {
      expect(end.payee.confirmationToken).toBe('tok-live');
    }
  });

  it('a fresh resolve after rejection replaces the stale token (never carries the old one)', () => {
    const end = drive([
      { type: 'destinationResolved', payee: payee({ confirmationToken: 'stale-token' }) },
      { type: 'payeeRejected' },
      { type: 'destinationResolved', payee: payee({ confirmationToken: 'fresh-token' }) },
      { type: 'payeeConfirmed', idempotencyKey: 'idem-2' },
    ]);
    expect(end.step).toBe('amount');
    if (end.step === 'amount') {
      expect(end.payee.confirmationToken).toBe('fresh-token');
      expect(end.payee.confirmationToken).not.toBe('stale-token');
    }
  });

  it('reset from the confirm step drops the resolved payee/token', () => {
    const confirm = drive([{ type: 'destinationResolved', payee: payee() }]);
    expect(transferFlowReducer(confirm, { type: 'reset' })).toEqual({ step: 'resolve' });
  });
});

describe('transferFlowReducer — idempotency-key stability (double-spend guard)', () => {
  it('preserves the key byte-for-byte across the duplicate-suspected branch (the retry path)', () => {
    const amount = drive([
      { type: 'destinationResolved', payee: payee() },
      { type: 'payeeConfirmed', idempotencyKey: 'KEY-ONCE' },
    ]);
    const flagged = transferFlowReducer(amount, { type: 'duplicateSuspected' });
    expect(flagged.step).toBe('amount');
    if (flagged.step === 'amount') {
      // The "Send anyway" re-submit reuses this exact key — a regenerated key would double-spend.
      expect(flagged.idempotencyKey).toBe('KEY-ONCE');
      expect(flagged.suspectedDuplicate).toBe(true);
    }
  });

  it('a stray repeat payeeConfirmed at the amount step can NOT regenerate the key', () => {
    const amount = drive([
      { type: 'destinationResolved', payee: payee() },
      { type: 'payeeConfirmed', idempotencyKey: 'KEY-ONCE' },
    ]);
    // A double callback trying to confirm again with a NEW key must be ignored (guarded to
    // confirmPayee) — otherwise the in-flight transfer's key would change mid-flow.
    const after = transferFlowReducer(amount, {
      type: 'payeeConfirmed',
      idempotencyKey: 'KEY-TWO',
    });
    expect(after).toBe(amount); // unchanged reference — no transition, no new key
  });
});

describe('transferFlowReducer — guards reject illegal transitions (stray dispatches are no-ops)', () => {
  const resolve: TransferFlowState = { step: 'resolve' };
  const confirm: TransferFlowState = { step: 'confirmPayee', payee: payee() };
  const amount: TransferFlowState = {
    step: 'amount',
    payee: payee(),
    idempotencyKey: 'idem',
    suspectedDuplicate: false,
  };
  const otp: TransferFlowState = { step: 'awaitingOtp', transfer: pendingView() };

  it.each([
    [
      'destinationResolved outside resolve',
      amount,
      { type: 'destinationResolved', payee: payee() },
    ],
    [
      'payeeConfirmed outside confirmPayee',
      resolve,
      { type: 'payeeConfirmed', idempotencyKey: 'x' },
    ],
    ['payeeRejected outside confirmPayee', amount, { type: 'payeeRejected' }],
    ['duplicateSuspected outside amount', otp, { type: 'duplicateSuspected' }],
    [
      'transferInitiated outside amount',
      confirm,
      { type: 'transferInitiated', transfer: pendingView() },
    ],
    ['transferPosted outside awaitingOtp', resolve, { type: 'transferPosted' }],
    ['transferCancelled outside awaitingOtp', amount, { type: 'transferCancelled' }],
  ] as const)('ignores %s', (_label, state, action) => {
    expect(transferFlowReducer(state, action)).toBe(state);
  });
});

describe('transferFlowReducer — reset and resume apply from any step', () => {
  const states: TransferFlowState[] = [
    { step: 'resolve' },
    { step: 'confirmPayee', payee: payee() },
    { step: 'amount', payee: payee(), idempotencyKey: 'i', suspectedDuplicate: true },
    { step: 'awaitingOtp', transfer: pendingView() },
    { step: 'posted', transfer: pendingView() },
    { step: 'cancelled' },
  ];

  it('reset returns to the initial resolve step from every step', () => {
    for (const state of states) {
      expect(transferFlowReducer(state, { type: 'reset' })).toEqual({ step: 'resolve' });
    }
  });

  it('resumePending jumps straight to the confirm step from every step', () => {
    const view = pendingView({ transferId: 'resumed-id' });
    for (const state of states) {
      expect(transferFlowReducer(state, { type: 'resumePending', transfer: view })).toEqual({
        step: 'awaitingOtp',
        transfer: view,
      });
    }
  });
});
