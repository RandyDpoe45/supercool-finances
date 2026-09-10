/**
 * Spec 04 — Balance Service, STEP 8b: the maker-checker `ApprovalService` (four-eyes reversals),
 * driven as a PURE unit (no DB, only a Nest TestingModule + mocked collaborators) so it runs in the
 * DEFAULT `npm test`. Written FROM the spec's "/admin Maker-checker (four-eyes)" bullet + the
 * developer-locked step-8b contract, NOT from the implementor's code:
 *
 *   - `approve(checker, id)` executes ATOMICALLY through the guarded `transitionToExecutedInTx`
 *     (the maker-checker concurrency gate): if that guarded PENDING→EXECUTED transition returns
 *     FALSE (a concurrent checker already won), it ABORTS — the compensating movement is NOT posted
 *     and the original is NOT transitioned to REVERSED — and rejects (APPROVAL_NOT_PENDING). The
 *     guard is checked BEFORE the post: a defect that posted first would still move money on the
 *     losing racer.
 *   - `proposeReversal(maker, txId)` rejects a target that is NOT a POSTED internal / POSTED
 *     external_inbound (TRANSACTION_NOT_REVERSIBLE) and one that ALREADY has a live approval
 *     (REVERSAL_ALREADY_REQUESTED) — creating NO approval row and writing NO audit.
 *   - FOUR-EYES: when `checker === maker`, both `approve` and `reject` reject with
 *     SELF_APPROVAL_FORBIDDEN and attempt NO repo transition (the service-side half of the invariant
 *     the DB CHECK `checker_id <> maker_id` backstops).
 *   - Positive controls: a valid propose creates a PENDING approval + audits `reversal.proposed`; a
 *     valid approve posts the compensating movement (a `forced` command carrying
 *     `reversesTransactionId` = original and MIRRORED legs) + audits `reversal.executed`.
 *
 * Collaborators are MOCKED (matched by DI token via `useMocker`, so injection is order-independent),
 * but the ORCHESTRATION under test (the guard-before-post ordering, the reversibility gate, the
 * four-eyes gate, the shape of the compensating command) is the service's OWN and is NOT mocked away.
 * The AUTHORITATIVE money proofs (a real REVERSED transfer, the two-concurrent-approves keystone, the
 * FORCED-goes-negative case) live in tests/integration/reversals.integration.spec.ts; this unit pins
 * the branch logic a pure test catches fast.
 *
 * Honest-SKIP: the step-8b module is authored in parallel — if the ApprovalService class / its token
 * / the approval-request repo token are not yet resolvable through tests/support/harness.ts, the suite
 * SKIPs loudly rather than crashing (or silently passing) the default run. It activates the moment the
 * service exists.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import * as harness from '../support/harness';

function tryResolve<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

const ApprovalService = tryResolve(() => harness.getApprovalService?.());
const APPROVAL_TOKEN = tryResolve(() => harness.getApprovalServiceToken());
const APPROVAL_REPO_TOKEN = tryResolve(() => harness.getApprovalRequestRepositoryToken());
const TRANSACTION_REPO_TOKEN = tryResolve(() =>
  harness.getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction'),
);
const POSTING_TOKEN = tryResolve(() => harness.getPostingServiceToken());
const AUDIT_TOKEN = tryResolve(() => harness.getAuditServiceToken());
const DS_TOKEN = tryResolve(() => getDataSourceToken());
const ae: any = harness.getApprovalErrors();

const hasMethods =
  ApprovalService &&
  ['proposeReversal', 'approve', 'reject'].every(
    (m) => typeof ApprovalService?.prototype?.[m] === 'function',
  );

const canRun = Boolean(
  ApprovalService &&
  APPROVAL_TOKEN &&
  APPROVAL_REPO_TOKEN &&
  TRANSACTION_REPO_TOKEN &&
  POSTING_TOKEN &&
  hasMethods,
);

if (!canRun) {
  console.info(
    '[unit] SKIPPED approval.service suite: could not resolve the ApprovalService class / its token / ' +
      'the approval-request repo token / proposeReversal+approve+reject via tests/support/harness.ts ' +
      '(getApprovalService / getApprovalServiceToken / getApprovalRequestRepositoryToken). Add the ' +
      'path/export there — the single coordination point — and the suite activates once step-8b exists.',
  );
}

const suite = canRun ? describe : describe.skip;

const MAKER = 'admin-maker';
const CHECKER = 'admin-checker';
const ORIG_TX = 'orig-tx-1';
const APPROVAL_ID = 'approval-1';
const ACC_A = 'acc-A-debit-original';
const ACC_B = 'acc-B-credit-original';
const MXN = 'MXN';

function isDataSourceToken(token: any): boolean {
  if (token === DataSource) return true;
  if (DS_TOKEN && token === DS_TOKEN) return true;
  return typeof token === 'string' && /datasource|connection/i.test(token);
}

function autoMock(): any {
  const cache = new Map<PropertyKey, any>();
  const target: any = () => undefined;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (!cache.has(prop)) cache.set(prop, jest.fn());
      return cache.get(prop);
    },
    apply: () => undefined,
  });
}

/** A POSTED internal transfer A→B (the reversible target), overridable per test. */
function postedInternal(overrides: Record<string, unknown> = {}): any {
  return {
    id: ORIG_TX,
    type: 'internal',
    status: 'POSTED',
    amount: '4000',
    currency: MXN,
    debitAccountId: ACC_A,
    creditAccountId: ACC_B,
    initiatedBy: 'sub-sender',
    reversesTransactionId: null,
    ...overrides,
  };
}

/** A PENDING approval proposed by MAKER against ORIG_TX. */
function pendingApproval(overrides: Record<string, unknown> = {}): any {
  return {
    id: APPROVAL_ID,
    actionType: 'reversal',
    status: 'PENDING',
    makerId: MAKER,
    checkerId: null,
    targetTransactionId: ORIG_TX,
    ...overrides,
  };
}

interface State {
  transaction: any; // proposeReversal target + approve/reject reversal target
  approval: any; // approve/reject subject (null ⇒ APPROVAL_NOT_FOUND)
  existingApprovals: any[]; // findByTargetTransaction result (live approvals ⇒ REVERSAL_ALREADY_REQUESTED)
  executeResult: boolean; // guarded PENDING→EXECUTED transition result
  rejectResult: boolean; // guarded PENDING→REJECTED transition result
  reversedResult: boolean; // guarded POSTED→REVERSED transition result
}

interface Mocks {
  approvalRepo: any;
  transactionRepo: any;
  posting: any;
  audit: any;
  dataSource: any;
  queryRunner: any;
  state: State;
}

function makeMocks(state: State): Mocks {
  const queryRunner: any = {
    isTransactionActive: true,
    manager: { query: jest.fn(async () => []), save: jest.fn(async (e: any) => e) },
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async () => []),
  };

  const approvalRepo = {
    findById: jest.fn(async () => state.approval),
    findByIdInTx: jest.fn(async () => state.approval),
    findByTargetTransaction: jest.fn(async () => state.existingApprovals),
    createInTx: jest.fn(async (_qr: any, data: any) => ({
      id: APPROVAL_ID,
      status: 'PENDING',
      ...data,
    })),
    transitionToExecutedInTx: jest.fn(async () => state.executeResult),
    transitionToRejectedInTx: jest.fn(async () => state.rejectResult),
  };

  const transactionRepo = {
    findById: jest.fn(async () => state.transaction),
    findByIdInTx: jest.fn(async () => state.transaction),
    transitionToReversedInTx: jest.fn(async () => state.reversedResult),
  };

  const posting = {
    postTransaction: jest.fn(async () => ({ id: 'tx-comp', status: 'POSTED' })),
    postPendingInTx: jest.fn(async () => ({ id: 'tx-comp', status: 'POSTED' })),
    postFreshInTx: jest.fn(async () => ({ id: 'tx-comp', status: 'POSTED' })),
  };

  const audit = {
    recordInTx: jest.fn(async () => undefined),
    record: jest.fn(async () => undefined),
  };

  const dataSource = {
    createQueryRunner: jest.fn(() => queryRunner),
    transaction: jest.fn(async (arg1: any, arg2: any) => {
      const cb = typeof arg1 === 'function' ? arg1 : arg2;
      return cb(queryRunner.manager);
    }),
    query: jest.fn(async () => []),
  };

  return { approvalRepo, transactionRepo, posting, audit, dataSource, queryRunner, state };
}

function defaultState(overrides: Partial<State> = {}): State {
  return {
    transaction: postedInternal(),
    approval: pendingApproval(),
    existingApprovals: [],
    executeResult: true,
    rejectResult: true,
    reversedResult: true,
    ...overrides,
  };
}

async function setup(state: State): Promise<{ service: any; mocks: Mocks }> {
  const mocks = makeMocks(state);
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: APPROVAL_TOKEN as symbol, useClass: ApprovalService }],
  })
    .useMocker((token) => {
      if (token === APPROVAL_REPO_TOKEN) return mocks.approvalRepo;
      if (token === TRANSACTION_REPO_TOKEN) return mocks.transactionRepo;
      if (POSTING_TOKEN && token === POSTING_TOKEN) return mocks.posting;
      if (AUDIT_TOKEN && token === AUDIT_TOKEN) return mocks.audit;
      if (isDataSourceToken(token)) return mocks.dataSource;
      return autoMock();
    })
    .compile();
  const service = moduleRef.get(APPROVAL_TOKEN as symbol, { strict: false });
  return { service, mocks };
}

async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

function codeOf(err: any): string {
  if (ae.TransactionNotReversibleError && err instanceof ae.TransactionNotReversibleError)
    return 'TRANSACTION_NOT_REVERSIBLE';
  if (ae.ReversalAlreadyRequestedError && err instanceof ae.ReversalAlreadyRequestedError)
    return 'REVERSAL_ALREADY_REQUESTED';
  if (ae.ApprovalNotFoundError && err instanceof ae.ApprovalNotFoundError)
    return 'APPROVAL_NOT_FOUND';
  if (ae.ApprovalNotPendingError && err instanceof ae.ApprovalNotPendingError)
    return 'APPROVAL_NOT_PENDING';
  if (ae.SelfApprovalForbiddenError && err instanceof ae.SelfApprovalForbiddenError)
    return 'SELF_APPROVAL_FORBIDDEN';
  return (err?.code ?? '') as string;
}

const postingCalled = (m: Mocks): boolean =>
  m.posting.postFreshInTx.mock.calls.length > 0 ||
  m.posting.postTransaction.mock.calls.length > 0 ||
  m.posting.postPendingInTx.mock.calls.length > 0;

/** The compensating command handed to whichever posting method fired (the last object arg carrying
 *  `legs`), or undefined. */
function postedCommand(m: Mocks): any {
  const calls = [
    ...m.posting.postFreshInTx.mock.calls,
    ...m.posting.postTransaction.mock.calls,
    ...m.posting.postPendingInTx.mock.calls,
  ];
  for (const call of calls) {
    for (const arg of call) {
      if (arg && typeof arg === 'object' && Array.isArray(arg.legs)) return arg;
    }
  }
  return undefined;
}

// =============================================================================================
// approve — the guarded transition gates the post (the concurrency + money-safety keystone, unit)
// =============================================================================================

suite('ApprovalService.approve — guarded EXECUTED transition gates the compensating post', () => {
  it('POSITIVE CONTROL: a valid approve by a DIFFERENT checker posts a FORCED compensating movement (mirrored legs, reversesTransactionId=original) and audits reversal.executed', async () => {
    const { service, mocks } = await setup(defaultState());

    const res = await capture(service.approve(CHECKER, APPROVAL_ID));
    expect(res.ok).toBe(true);

    // The guarded PENDING→EXECUTED gate fired with the CHECKER (who is not the maker).
    expect(mocks.approvalRepo.transitionToExecutedInTx).toHaveBeenCalledTimes(1);
    const execArgs = mocks.approvalRepo.transitionToExecutedInTx.mock.calls[0];
    expect(execArgs).toContain(APPROVAL_ID);
    expect(execArgs).toContain(CHECKER);

    // The original is guarded POSTED→REVERSED, and a compensating movement is posted.
    expect(mocks.transactionRepo.transitionToReversedInTx).toHaveBeenCalledTimes(1);
    expect(postingCalled(mocks)).toBe(true);

    // The compensating command is FORCED, links to the original, and MIRRORS the legs (credit the
    // original DEBIT account, debit the original CREDIT account) — a balanced double-entry.
    const cmd = postedCommand(mocks);
    expect(cmd).toBeDefined();
    expect(cmd.forced).toBe(true);
    expect(cmd.reversesTransactionId).toBe(ORIG_TX);
    // NO limit enforcement on a reversal.
    expect(cmd.limitAccountId).toBeUndefined();
    const byId = new Map<string, string>(cmd.legs.map((l: any) => [l.accountId, String(l.delta)]));
    expect(byId.get(ACC_A)).toBe('4000'); // original debit account is CREDITED back
    expect(byId.get(ACC_B)).toBe('-4000'); // original credit account is DEBITED (the forced leg)

    // One audit row for the execution, naming the reversal + the original transaction.
    expect(mocks.audit.recordInTx).toHaveBeenCalledTimes(1);
    const entry = JSON.stringify(
      mocks.audit.recordInTx.mock.calls[0][mocks.audit.recordInTx.mock.calls[0].length - 1],
    );
    expect(entry).toContain('reversal.executed');
    expect(entry).toContain(ORIG_TX);
  });

  it('ABORT: when transitionToExecutedInTx returns FALSE (a concurrent checker already won), NO compensating post and NO reversed-transition happen, and it rejects APPROVAL_NOT_PENDING', async () => {
    // The concurrency loser: the approval is PENDING at read, the checker differs from the maker (so
    // it is NOT a self-approval), but the guarded execute transition touches 0 rows.
    const { service, mocks } = await setup(defaultState({ executeResult: false }));

    const res = await capture(service.approve(CHECKER, APPROVAL_ID));

    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('APPROVAL_NOT_PENDING');
    // The guard was attempted...
    expect(mocks.approvalRepo.transitionToExecutedInTx).toHaveBeenCalledTimes(1);
    // ...but because it lost, the reversal must NOT proceed: no money posted, original NOT reversed.
    expect(postingCalled(mocks)).toBe(false);
    expect(mocks.transactionRepo.transitionToReversedInTx).not.toHaveBeenCalled();
  });

  it('GATE #2 (no-double-reversal backstop): when the target was ALREADY reversed by a DIFFERENT executed approval, transitionToReversedInTx returns FALSE → approve throws TRANSACTION_NOT_REVERSIBLE and posts NOTHING', async () => {
    // The duplicate-proposal TOCTOU the best-effort propose guard admits: THIS approval passes gate #1
    // (it is PENDING, checker <> maker, so its own PENDING→EXECUTED transition succeeds), but the
    // guarded original POSTED→REVERSED touches 0 rows because a sibling approval already reversed the
    // target. The hard backstop must abort BEFORE the compensating post — no second reversal.
    const { service, mocks } = await setup(
      defaultState({ executeResult: true, reversedResult: false }),
    );

    const res = await capture(service.approve(CHECKER, APPROVAL_ID));

    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('TRANSACTION_NOT_REVERSIBLE');
    // Gate #1 passed (its own transition succeeded) and gate #2 WAS consulted...
    expect(mocks.approvalRepo.transitionToExecutedInTx).toHaveBeenCalledTimes(1);
    expect(mocks.transactionRepo.transitionToReversedInTx).toHaveBeenCalledTimes(1);
    // ...but because the target was already reversed, NO compensating movement is posted (the whole
    // tx rolls back, undoing this approval's EXECUTED transition too — a DB property proven in the
    // integration backstop test).
    expect(postingCalled(mocks)).toBe(false);
  });

  it('an unknown approval id → APPROVAL_NOT_FOUND; no transition attempted, no post', async () => {
    const { service, mocks } = await setup(defaultState({ approval: null }));

    const res = await capture(service.approve(CHECKER, 'nope'));

    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('APPROVAL_NOT_FOUND');
    expect(mocks.approvalRepo.transitionToExecutedInTx).not.toHaveBeenCalled();
    expect(postingCalled(mocks)).toBe(false);
  });
});

// =============================================================================================
// Four-eyes — checker === maker is forbidden on BOTH approve and reject, with NO transition
// =============================================================================================

suite('ApprovalService — four-eyes: a maker cannot decide their OWN request', () => {
  it('approve by the MAKER → SELF_APPROVAL_FORBIDDEN; NO execute-transition attempted, no post', async () => {
    const { service, mocks } = await setup(defaultState());

    const res = await capture(service.approve(MAKER, APPROVAL_ID)); // actor === approval.makerId

    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('SELF_APPROVAL_FORBIDDEN');
    // The four-eyes gate is checked BEFORE any state change: no transition, no money.
    expect(mocks.approvalRepo.transitionToExecutedInTx).not.toHaveBeenCalled();
    expect(mocks.transactionRepo.transitionToReversedInTx).not.toHaveBeenCalled();
    expect(postingCalled(mocks)).toBe(false);
  });

  it('reject by the MAKER → SELF_APPROVAL_FORBIDDEN; NO reject-transition attempted', async () => {
    const { service, mocks } = await setup(defaultState());

    const res = await capture(service.reject(MAKER, APPROVAL_ID));

    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(mocks.approvalRepo.transitionToRejectedInTx).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: reject by a DIFFERENT checker transitions to REJECTED, posts NOTHING, and audits reversal.rejected', async () => {
    const { service, mocks } = await setup(defaultState());

    const res = await capture(service.reject(CHECKER, APPROVAL_ID));
    expect(res.ok).toBe(true);

    expect(mocks.approvalRepo.transitionToRejectedInTx).toHaveBeenCalledTimes(1);
    expect(mocks.approvalRepo.transitionToRejectedInTx.mock.calls[0]).toContain(CHECKER);
    // A rejection never moves money and never reverses the target.
    expect(postingCalled(mocks)).toBe(false);
    expect(mocks.transactionRepo.transitionToReversedInTx).not.toHaveBeenCalled();
    const entry = JSON.stringify(
      mocks.audit.recordInTx.mock.calls[0]?.[mocks.audit.recordInTx.mock.calls[0].length - 1] ?? {},
    );
    expect(entry).toContain('reversal.rejected');
  });
});

// =============================================================================================
// proposeReversal — reversibility + already-requested gates (no approval row, no audit on reject)
// =============================================================================================

suite('ApprovalService.proposeReversal — reversibility gate', () => {
  it('POSITIVE CONTROL: a POSTED internal transfer → creates a PENDING approval and audits reversal.proposed', async () => {
    const { service, mocks } = await setup(defaultState());

    const res = await capture(service.proposeReversal(MAKER, ORIG_TX));
    expect(res.ok).toBe(true);

    expect(mocks.approvalRepo.createInTx).toHaveBeenCalledTimes(1);
    const created = mocks.approvalRepo.createInTx.mock.calls[0][1]; // (queryRunner, data) → the data
    const s = JSON.stringify(created);
    expect(s).toContain(MAKER); // the maker is recorded
    expect(s).toContain(ORIG_TX); // targeting the original transaction
    // The proposal is audited.
    const auditEntry = JSON.stringify(
      mocks.audit.recordInTx.mock.calls[0]?.[mocks.audit.recordInTx.mock.calls[0].length - 1] ?? {},
    );
    expect(auditEntry).toContain('reversal.proposed');
    // No money moves at proposal time.
    expect(postingCalled(mocks)).toBe(false);
  });

  it('a NON-POSTED target (PENDING) → TRANSACTION_NOT_REVERSIBLE; no approval created, no audit', async () => {
    const { service, mocks } = await setup(
      defaultState({ transaction: postedInternal({ status: 'PENDING' }) }),
    );

    const res = await capture(service.proposeReversal(MAKER, ORIG_TX));

    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('TRANSACTION_NOT_REVERSIBLE');
    expect(mocks.approvalRepo.createInTx).not.toHaveBeenCalled();
    expect(mocks.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('a POSTED external_outbound target → TRANSACTION_NOT_REVERSIBLE (its reversal is the rail-failure path, not admin)', async () => {
    const { service, mocks } = await setup(
      defaultState({ transaction: postedInternal({ type: 'external_outbound' }) }),
    );

    const res = await capture(service.proposeReversal(MAKER, ORIG_TX));

    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('TRANSACTION_NOT_REVERSIBLE');
    expect(mocks.approvalRepo.createInTx).not.toHaveBeenCalled();
  });

  it('a POSTED external_inbound target IS reversible → creates an approval (the credit-reversal case)', async () => {
    const { service, mocks } = await setup(
      defaultState({ transaction: postedInternal({ type: 'external_inbound' }) }),
    );

    const res = await capture(service.proposeReversal(MAKER, ORIG_TX));

    expect(res.ok).toBe(true);
    expect(mocks.approvalRepo.createInTx).toHaveBeenCalledTimes(1);
  });

  it('a target that ALREADY has a live approval → REVERSAL_ALREADY_REQUESTED; no second approval created', async () => {
    const { service, mocks } = await setup(
      defaultState({ existingApprovals: [pendingApproval()] }),
    );

    const res = await capture(service.proposeReversal(MAKER, ORIG_TX));

    expect(res.ok).toBe(false);
    expect(codeOf(res.error)).toBe('REVERSAL_ALREADY_REQUESTED');
    expect(mocks.approvalRepo.createInTx).not.toHaveBeenCalled();
  });
});
