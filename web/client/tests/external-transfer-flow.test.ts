import { describe, expect, it } from 'vitest';
import {
  externalTransferFlowReducer,
  initialExternalTransferFlowState,
  type ExternalTransferFlowAction,
  type ExternalTransferFlowState,
} from '../src/lib/externalTransferFlow';
import type { PendingTransferView } from '../src/lib/transferFlow';

/**
 * The EXTERNAL-transfer wizard reducer moves money via a HOLD placed at initiate, so its correctness
 * gets the sharpest, un-mocked tests (the reducer is pure — nothing is stubbed). Properties proven
 * here come FROM THE SPEC (spec 04 external outbound + docs/README "External-transfer journey"), not
 * from mirroring the code:
 *
 *  - the journey advances compose → awaitingOtp → posted (settle) or → cancelled (release), and each
 *    step carries the right payload (the posted receipt keeps the SAME pending view);
 *  - IDEMPOTENCY-KEY STABILITY: the key is fixed ONCE at flow start and survives the
 *    suspected-duplicate ("Send anyway") branch BYTE-FOR-BYTE; the ONLY thing that changes it is an
 *    explicit `reset` with a fresh page-generated key. A key regenerated mid-flow would let one
 *    logical transfer double-submit (a hold placed twice → double-spend), so a drift here is a hard
 *    failure;
 *  - there is NO confirmation-of-payee / resolve step (external addresses an enrolled payee by
 *    `payeeId`; the cooling-off delay is the anti-fraud gate) — the compose state carries no
 *    confirmation token / resolved-payee concept;
 *  - every non-reset/non-resume action is guarded to its originating step: a stray/duplicate dispatch
 *    is a no-op (returns the same reference), never an illegal transition.
 */

const KEY = '11111111-1111-4111-8111-aaaaaaaaaaaa';

function externalPendingView(overrides: Partial<PendingTransferView> = {}): PendingTransferView {
  // An external pending: the destination is the enrolled payee's label; the account-number/masked
  // fields are null (there is no resolve step for external).
  return {
    transferId: 'ffffffff-0000-4000-8000-000000000001',
    amount: '50000',
    currency: 'MXN',
    destinationAccountNumber: null,
    destinationMaskedName: null,
    payeeDisplayName: 'Landlord',
    expiresAt: '2026-09-10T00:02:00.000Z',
    ...overrides,
  };
}

function drive(
  actions: ExternalTransferFlowAction[],
  start: ExternalTransferFlowState = initialExternalTransferFlowState(KEY),
): ExternalTransferFlowState {
  return actions.reduce((state, action) => externalTransferFlowReducer(state, action), start);
}

describe('externalTransferFlowReducer — the happy journey', () => {
  it('starts at the compose step carrying ONLY the fixed key + suspectedDuplicate flag (no resolve/payee concept)', () => {
    const initial = initialExternalTransferFlowState(KEY);
    // Exact key set: proves there is no confirmationToken / resolvedPayee / resolve step on the
    // external compose step — external addresses a pre-enrolled payee by id.
    expect(initial).toEqual({ step: 'compose', idempotencyKey: KEY, suspectedDuplicate: false });
    expect(Object.keys(initial).sort()).toEqual(['idempotencyKey', 'step', 'suspectedDuplicate']);
  });

  it('walks compose → awaitingOtp → posted, keeping the pending view on the receipt', () => {
    const view = externalPendingView();
    const otp = drive([{ type: 'transferInitiated', transfer: view }]);
    expect(otp).toEqual({ step: 'awaitingOtp', transfer: view });

    const posted = externalTransferFlowReducer(otp, { type: 'transferPosted' });
    // The posted receipt must carry the SAME view forward (so it shows what was actually settled).
    expect(posted).toEqual({ step: 'posted', transfer: view });
  });

  it('cancels from the awaitingOtp step to the cancelled terminal (hold released)', () => {
    const otp: ExternalTransferFlowState = { step: 'awaitingOtp', transfer: externalPendingView() };
    expect(externalTransferFlowReducer(otp, { type: 'transferCancelled' })).toEqual({
      step: 'cancelled',
    });
  });
});

describe('externalTransferFlowReducer — idempotency-key stability (double-spend / double-hold guard)', () => {
  it('preserves the key byte-for-byte across the suspected-duplicate branch (the "Send anyway" retry)', () => {
    const flagged = drive([{ type: 'duplicateSuspected' }]);
    expect(flagged.step).toBe('compose');
    if (flagged.step === 'compose') {
      // "Send anyway" re-submits with THIS exact key + confirmDuplicate — a regenerated key would
      // place a second hold (double-spend), so the key must be untouched.
      expect(flagged.idempotencyKey).toBe(KEY);
      expect(flagged.suspectedDuplicate).toBe(true);
    }
  });

  it('a repeated duplicateSuspected never regenerates the key (idempotent flag flip)', () => {
    const once = drive([{ type: 'duplicateSuspected' }]);
    const twice = externalTransferFlowReducer(once, { type: 'duplicateSuspected' });
    expect(twice.step).toBe('compose');
    if (twice.step === 'compose') {
      expect(twice.idempotencyKey).toBe(KEY);
      expect(twice.suspectedDuplicate).toBe(true);
    }
  });

  it('only an explicit reset changes the key — and only to the fresh page-supplied one', () => {
    const flagged = drive([{ type: 'duplicateSuspected' }]);
    const FRESH = '22222222-2222-4222-8222-bbbbbbbbbbbb';
    const afterReset = externalTransferFlowReducer(flagged, {
      type: 'reset',
      idempotencyKey: FRESH,
    });
    // A reset abandons the logical transfer and starts a NEW one, so a fresh key is correct here —
    // and the suspected-duplicate flag is cleared.
    expect(afterReset).toEqual({
      step: 'compose',
      idempotencyKey: FRESH,
      suspectedDuplicate: false,
    });
    expect(FRESH).not.toBe(KEY);
  });
});

describe('externalTransferFlowReducer — guards reject illegal transitions (stray dispatches are no-ops)', () => {
  const compose: ExternalTransferFlowState = {
    step: 'compose',
    idempotencyKey: KEY,
    suspectedDuplicate: false,
  };
  const otp: ExternalTransferFlowState = { step: 'awaitingOtp', transfer: externalPendingView() };
  const posted: ExternalTransferFlowState = { step: 'posted', transfer: externalPendingView() };
  const cancelled: ExternalTransferFlowState = { step: 'cancelled' };

  it.each([
    ['duplicateSuspected outside compose', otp, { type: 'duplicateSuspected' }],
    ['duplicateSuspected on a posted transfer', posted, { type: 'duplicateSuspected' }],
    [
      'transferInitiated outside compose',
      otp,
      { type: 'transferInitiated', transfer: externalPendingView() },
    ],
    ['transferPosted outside awaitingOtp', compose, { type: 'transferPosted' }],
    ['transferPosted on a cancelled transfer', cancelled, { type: 'transferPosted' }],
    ['transferCancelled outside awaitingOtp', compose, { type: 'transferCancelled' }],
    ['transferCancelled on a posted transfer', posted, { type: 'transferCancelled' }],
  ] as const)('ignores %s (returns the SAME state reference)', (_label, state, action) => {
    expect(externalTransferFlowReducer(state, action)).toBe(state);
  });
});

describe('externalTransferFlowReducer — reset and resume apply from any step', () => {
  const states: ExternalTransferFlowState[] = [
    { step: 'compose', idempotencyKey: KEY, suspectedDuplicate: false },
    { step: 'compose', idempotencyKey: KEY, suspectedDuplicate: true },
    { step: 'awaitingOtp', transfer: externalPendingView() },
    { step: 'posted', transfer: externalPendingView() },
    { step: 'cancelled' },
  ];

  it('reset returns to a clean compose step (fresh key, flag cleared) from every step', () => {
    const FRESH = '33333333-3333-4333-8333-cccccccccccc';
    for (const state of states) {
      expect(externalTransferFlowReducer(state, { type: 'reset', idempotencyKey: FRESH })).toEqual({
        step: 'compose',
        idempotencyKey: FRESH,
        suspectedDuplicate: false,
      });
    }
  });

  it('resumePending jumps straight to the confirm step from every step (a pending can surface anytime)', () => {
    const view = externalPendingView({ transferId: 'resumed-external-id' });
    for (const state of states) {
      expect(externalTransferFlowReducer(state, { type: 'resumePending', transfer: view })).toEqual(
        { step: 'awaitingOtp', transfer: view },
      );
    }
  });
});
