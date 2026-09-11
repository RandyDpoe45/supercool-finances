import type { AdminAccountDto } from '../../services/api/contracts/account';
import type { ApprovalRequestDto } from '../../services/api/contracts/approval';
import type { AuditLogDto } from '../../services/api/contracts/audit';
import type { LimitsDto, UpsertLimitsBody } from '../../services/api/contracts/limits';
import type { AdminTransactionDto } from '../../services/api/contracts/transaction';
import { fixtureAccounts } from '../fixtures/accounts';
import { fixtureApprovals } from '../fixtures/approvals';
import { fixtureAudit } from '../fixtures/audit';
import { fixtureLimits } from '../fixtures/limits';
import { fixtureTransactions } from '../fixtures/transactions';

/**
 * In-memory admin state for the MSW stub, mirroring the balance-service admin surface closely enough
 * to exercise the account-management, limits, and maker-checker reversal screens WITHOUT a backend:
 * account freeze/unfreeze (status flips + `updatedAt` bump), owner-filtered + paged account listing
 * (limit clamped ≤200, default 50), limits upsert keyed by (scope, ownerId, currency), transaction
 * listing (filtered + paged), and the reversal maker-checker flow (propose → approve/reject) with the
 * SAME domain guards the real service enforces: reversibility (POSTED && internal|external_inbound),
 * four-eyes (checker ≠ maker), and the propose-time duplicate guard.
 *
 * State lives at MODULE scope (the browser worker and the node test server each get their own
 * instance) and therefore SURVIVES `server.resetHandlers()` — so a test that mutated it must call
 * {@link resetAdminState} to return to the pristine fixtures (this mirrors how web/client keeps its
 * mutable `mocks/state/` separate from the request handlers). Seeds are DEEP-COPIED on reset so
 * mutations never bleed back into the frozen fixtures.
 *
 * Money values (balances, caps) are minor-unit STRINGS throughout — never parsed to a float.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface AdminState {
  accounts: AdminAccountDto[];
  limits: LimitsDto[];
  transactions: AdminTransactionDto[];
  approvals: ApprovalRequestDto[];
  audit: AuditLogDto[];
}

function seed(): AdminState {
  return {
    accounts: fixtureAccounts.map((account) => ({ ...account })),
    limits: fixtureLimits.map((row) => ({ ...row })),
    transactions: fixtureTransactions.map((tx) => ({ ...tx })),
    approvals: fixtureApprovals.map((approval) => ({ ...approval })),
    // Deep-cloned: an audit entry's `metadata` is a nested object, so a shallow spread would share it
    // back into the frozen fixture (the log is read-only, but keep the seed self-contained).
    audit: fixtureAudit.map((entry) => structuredClone(entry)),
  };
}

let state: AdminState = seed();

/** Reset (reseed) all admin state from the pristine fixtures — for test isolation. */
export function resetAdminState(): void {
  state = seed();
}

/**
 * The admin-visible accounts, optionally filtered to one `ownerId`, then paged. `limit` defaults to
 * 50 and is clamped to `[1, 200]`; `offset` defaults to 0 (a negative/NaN offset clamps to 0). The
 * caller receives copies so it cannot mutate stored rows.
 */
export function listAccounts(params: {
  ownerId?: string;
  limit?: number;
  offset?: number;
}): AdminAccountDto[] {
  const filtered = params.ownerId
    ? state.accounts.filter((account) => account.ownerId === params.ownerId)
    : state.accounts;
  // A missing / non-numeric limit falls back to the default (50) before clamping to [1, 200].
  const limit = clamp(
    Number.isFinite(params.limit) ? (params.limit as number) : DEFAULT_LIMIT,
    1,
    MAX_LIMIT,
  );
  const offset =
    Number.isFinite(params.offset) && (params.offset ?? 0) > 0 ? (params.offset as number) : 0;
  return filtered.slice(offset, offset + limit).map((account) => ({ ...account }));
}

/** Set an account's status to `frozen`, bumping `updatedAt`. Returns the updated row, or `undefined`
 * when the id is unknown (→ the handler returns 404). Already-frozen is idempotent. */
export function freezeAccount(id: string): AdminAccountDto | undefined {
  return setAccountStatus(id, 'frozen');
}

/** Set an account's status to `active`, bumping `updatedAt`. Returns the updated row, or `undefined`
 * when the id is unknown (→ 404). Already-active is idempotent. */
export function unfreezeAccount(id: string): AdminAccountDto | undefined {
  return setAccountStatus(id, 'active');
}

function setAccountStatus(id: string, status: string): AdminAccountDto | undefined {
  const account = state.accounts.find((candidate) => candidate.id === id);
  if (!account) {
    return undefined;
  }
  account.status = status;
  account.updatedAt = new Date().toISOString();
  return { ...account };
}

/** The limits rows, optionally filtered by `scope` and/or `ownerId`. Copies are returned. */
export function listLimits(params: { scope?: string; ownerId?: string }): LimitsDto[] {
  return state.limits
    .filter((row) => (params.scope ? row.scope === params.scope : true))
    .filter((row) => (params.ownerId ? row.ownerId === params.ownerId : true))
    .map((row) => ({ ...row }));
}

/**
 * Upsert a limits row. The REAL controller's conflict target is (scope, owner_id); this stub
 * additionally matches on `currency` — a benign simplification given the demo is MXN-only (a
 * same-(scope, owner) upsert in a different currency would insert here where the controller updates
 * in place, but that is unreachable in the current single-currency setup). Updates an existing row's
 * caps (+ `updatedAt`) or inserts a new one. `ownerId` is normalized by scope — `global` stores `null`,
 * `customer` stores the given owner — and each cap is normalized to a minor-unit string or `null`
 * (uncapped). Returns the resulting row. The scope⇒ownerId rule is enforced by the handler before
 * this runs, so a well-formed body is assumed here.
 */
export function upsertLimits(body: UpsertLimitsBody): LimitsDto {
  const ownerId = body.scope === 'customer' ? (body.ownerId ?? null) : null;
  const perTransactionMax = body.perTransactionMax ?? null;
  const dailyMax = body.dailyMax ?? null;
  const monthlyMax = body.monthlyMax ?? null;
  const now = new Date().toISOString();

  const existing = state.limits.find(
    (row) => row.scope === body.scope && row.ownerId === ownerId && row.currency === body.currency,
  );
  if (existing) {
    existing.perTransactionMax = perTransactionMax;
    existing.dailyMax = dailyMax;
    existing.monthlyMax = monthlyMax;
    existing.updatedAt = now;
    return { ...existing };
  }

  const created: LimitsDto = {
    id: crypto.randomUUID(),
    scope: body.scope,
    ownerId,
    currency: body.currency,
    perTransactionMax,
    dailyMax,
    monthlyMax,
    createdAt: now,
    updatedAt: now,
  };
  state.limits.push(created);
  return { ...created };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

// --- Maker-checker reversals -------------------------------------------------------------------

/** The domain error codes the reversal flow can surface; the handler maps each to an HTTP status. */
export type ReversalDomainCode =
  | 'TRANSFER_NOT_FOUND'
  | 'TRANSACTION_NOT_REVERSIBLE'
  | 'REVERSAL_ALREADY_REQUESTED'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_NOT_PENDING'
  | 'SELF_APPROVAL_FORBIDDEN';

/** A discriminated result: either the produced value, or a domain code the handler maps to a status.
 * Keeps the stub's business decisions here and the HTTP mapping in `handlers.ts`. */
export type DomainResult<T> = { ok: true; value: T } | { ok: false; code: ReversalDomainCode };

/** Reversibility, mirroring the balance-service rule VERBATIM: a POSTED `internal` transfer or a
 * POSTED `external_inbound` credit. `external_outbound` and any non-POSTED state are NOT reversible. */
function isReversibleTransaction(tx: AdminTransactionDto): boolean {
  return tx.status === 'POSTED' && (tx.type === 'internal' || tx.type === 'external_inbound');
}

/**
 * The admin-visible transactions, filtered by any present param, then paged (same clamp as
 * {@link listAccounts}: default 50, max 200, offset ≥0). `status` / `type` / `accountId` map cleanly
 * (accountId matches EITHER leg). `ownerId` is a BEST-EFFORT stub filter matched against
 * `initiatedBy` — the `AdminTransactionDto` carries no `ownerId` field (the real service resolves
 * ownership through the account legs, which the stub does not model), so this only finds transactions
 * a given owner initiated, not every transaction touching their accounts. Copies are returned.
 */
export function listTransactions(params: {
  ownerId?: string;
  accountId?: string;
  status?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): AdminTransactionDto[] {
  const filtered = state.transactions.filter((tx) => {
    if (params.ownerId && tx.initiatedBy !== params.ownerId) {
      return false;
    }
    if (
      params.accountId &&
      tx.debitAccountId !== params.accountId &&
      tx.creditAccountId !== params.accountId
    ) {
      return false;
    }
    if (params.status && tx.status !== params.status) {
      return false;
    }
    if (params.type && tx.type !== params.type) {
      return false;
    }
    return true;
  });
  const limit = clamp(
    Number.isFinite(params.limit) ? (params.limit as number) : DEFAULT_LIMIT,
    1,
    MAX_LIMIT,
  );
  const offset =
    Number.isFinite(params.offset) && (params.offset ?? 0) > 0 ? (params.offset as number) : 0;
  return filtered.slice(offset, offset + limit).map((tx) => ({ ...tx }));
}

/** Approval requests filtered by `status` — DEFAULTS to `PENDING` (the checker's queue), matching the
 * service. Copies are returned. */
export function listApprovals(params: { status?: string }): ApprovalRequestDto[] {
  const status = params.status ?? 'PENDING';
  return state.approvals
    .filter((approval) => approval.status === status)
    .map((row) => ({ ...row }));
}

/**
 * Propose a reversal (the MAKER action). Mirrors the service's order of checks: unknown target →
 * `TRANSFER_NOT_FOUND`; not reversible → `TRANSACTION_NOT_REVERSIBLE`; an existing PENDING or EXECUTED
 * approval for the SAME target → `REVERSAL_ALREADY_REQUESTED` (the propose-time duplicate guard); else
 * push a new PENDING approval and return it. `checkerId` / `decidedAt` / `executedAt` are null while
 * PENDING; `reason` is not surfaced on the DTO (the service keeps it on an internal payload).
 */
export function proposeReversal(
  makerId: string,
  transactionId: string,
  // The reason is validated + carried at the handler edge (matching the real wire contract) but not
  // modeled in stub state — the service records it on an internal payload the DTO never surfaces. The
  // `_` prefix marks it intentionally unused (TS `noUnusedParameters`); the disable is for ESLint.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _reason?: string,
): DomainResult<ApprovalRequestDto> {
  const target = state.transactions.find((tx) => tx.id === transactionId);
  if (!target) {
    return { ok: false, code: 'TRANSFER_NOT_FOUND' };
  }
  if (!isReversibleTransaction(target)) {
    return { ok: false, code: 'TRANSACTION_NOT_REVERSIBLE' };
  }
  const hasBlockingApproval = state.approvals.some(
    (approval) =>
      approval.targetTransactionId === transactionId &&
      (approval.status === 'PENDING' || approval.status === 'EXECUTED'),
  );
  if (hasBlockingApproval) {
    return { ok: false, code: 'REVERSAL_ALREADY_REQUESTED' };
  }
  const approval: ApprovalRequestDto = {
    id: crypto.randomUUID(),
    actionType: 'reversal',
    status: 'PENDING',
    makerId,
    checkerId: null,
    targetTransactionId: transactionId,
    createdAt: new Date().toISOString(),
    decidedAt: null,
    executedAt: null,
  };
  state.approvals.push(approval);
  return { ok: true, value: { ...approval } };
}

/**
 * Approve a PENDING reversal (the CHECKER action) — EXECUTES it. Mirrors the service: unknown id →
 * `APPROVAL_NOT_FOUND`; not PENDING → `APPROVAL_NOT_PENDING`; `checkerId === makerId` (four-eyes) →
 * `SELF_APPROVAL_FORBIDDEN`. On success the approval transitions to EXECUTED, the target transaction
 * flips POSTED → REVERSED (`failureReason: 'admin_reversal'`), and a balanced COMPENSATING transaction
 * is pushed (mirrored legs, `reversesTransactionId` → the target, initiated by the checker). Returns
 * the EXECUTED approval.
 */
export function approveReversal(
  checkerId: string,
  approvalId: string,
): DomainResult<ApprovalRequestDto> {
  const approval = state.approvals.find((row) => row.id === approvalId);
  if (!approval) {
    return { ok: false, code: 'APPROVAL_NOT_FOUND' };
  }
  if (approval.status !== 'PENDING') {
    return { ok: false, code: 'APPROVAL_NOT_PENDING' };
  }
  if (checkerId === approval.makerId) {
    return { ok: false, code: 'SELF_APPROVAL_FORBIDDEN' };
  }
  const now = new Date().toISOString();
  approval.status = 'EXECUTED';
  approval.checkerId = checkerId;
  approval.decidedAt = now;
  approval.executedAt = now;

  // Flip the target POSTED → REVERSED and push the balanced compensating post (only when the target
  // is still POSTED — the guarded transition the real service relies on).
  const target = state.transactions.find((tx) => tx.id === approval.targetTransactionId);
  if (target && target.status === 'POSTED') {
    target.status = 'REVERSED';
    target.failureReason = 'admin_reversal';
    const compensating: AdminTransactionDto = {
      id: crypto.randomUUID(),
      type: target.type,
      status: 'POSTED',
      amount: target.amount,
      currency: target.currency,
      // Mirrored legs: debit the original credit account, credit the original debit account.
      debitAccountId: target.creditAccountId,
      creditAccountId: target.debitAccountId,
      payeeId: null,
      reversesTransactionId: target.id,
      initiatedBy: checkerId,
      failureReason: null,
      createdAt: now,
      postedAt: now,
      failedAt: null,
      expiresAt: null,
    };
    state.transactions.push(compensating);
  }
  return { ok: true, value: { ...approval } };
}

/**
 * Reject a PENDING reversal (the CHECKER action) — moves no money. Mirrors the service: unknown id →
 * `APPROVAL_NOT_FOUND`; not PENDING → `APPROVAL_NOT_PENDING`; four-eyes → `SELF_APPROVAL_FORBIDDEN`.
 * On success the approval transitions to REJECTED (`checkerId` + `decidedAt` set, `executedAt` stays
 * null). Returns the REJECTED approval.
 */
export function rejectReversal(
  checkerId: string,
  approvalId: string,
): DomainResult<ApprovalRequestDto> {
  const approval = state.approvals.find((row) => row.id === approvalId);
  if (!approval) {
    return { ok: false, code: 'APPROVAL_NOT_FOUND' };
  }
  if (approval.status !== 'PENDING') {
    return { ok: false, code: 'APPROVAL_NOT_PENDING' };
  }
  if (checkerId === approval.makerId) {
    return { ok: false, code: 'SELF_APPROVAL_FORBIDDEN' };
  }
  approval.status = 'REJECTED';
  approval.checkerId = checkerId;
  approval.decidedAt = new Date().toISOString();
  return { ok: true, value: { ...approval } };
}

// --- Audit log ---------------------------------------------------------------------------------

/**
 * The admin audit log, optionally filtered by any present param (exact match on `actorId` / `action` /
 * `targetType` / `targetId`), sorted **newest-first** (`createdAt` DESC, then `id` DESC as a
 * bigint-aware tiebreak), then paged with the SAME clamp as {@link listAccounts} (`limit` default 50,
 * clamped `[1, 200]`; `offset` ≥ 0). Copies are returned. The log is READ-ONLY — there is no mutator.
 */
export function listAudit(params: {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  offset?: number;
}): AuditLogDto[] {
  const filtered = state.audit.filter((entry) => {
    if (params.actorId && entry.actorId !== params.actorId) {
      return false;
    }
    if (params.action && entry.action !== params.action) {
      return false;
    }
    if (params.targetType && entry.targetType !== params.targetType) {
      return false;
    }
    if (params.targetId && entry.targetId !== params.targetId) {
      return false;
    }
    return true;
  });
  const sorted = [...filtered].sort(compareAuditNewestFirst);
  const limit = clamp(
    Number.isFinite(params.limit) ? (params.limit as number) : DEFAULT_LIMIT,
    1,
    MAX_LIMIT,
  );
  const offset =
    Number.isFinite(params.offset) && (params.offset ?? 0) > 0 ? (params.offset as number) : 0;
  return sorted.slice(offset, offset + limit).map((entry) => ({ ...entry }));
}

/** Newest-first ordering: `createdAt` DESC (ISO-8601 UTC strings compare chronologically), then `id`
 * DESC as a bigint-aware tiebreak so `'10'` precedes `'9'` (a numeric compare, never lexicographic). */
function compareAuditNewestFirst(a: AuditLogDto, b: AuditLogDto): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  const aId = BigInt(a.id);
  const bId = BigInt(b.id);
  if (aId === bId) {
    return 0;
  }
  return aId < bId ? 1 : -1;
}
