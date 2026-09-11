import type { AdminAccountDto } from '../../services/api/contracts/account';
import type { LimitsDto, UpsertLimitsBody } from '../../services/api/contracts/limits';
import { fixtureAccounts } from '../fixtures/accounts';
import { fixtureLimits } from '../fixtures/limits';

/**
 * In-memory admin state for the MSW stub, mirroring the balance-service admin surface closely enough
 * to exercise the account-management + limits screens WITHOUT a backend: account freeze/unfreeze
 * (status flips + `updatedAt` bump), owner-filtered + paged account listing (limit clamped ≤200,
 * default 50), and limits upsert keyed by (scope, ownerId, currency).
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
}

function seed(): AdminState {
  return {
    accounts: fixtureAccounts.map((account) => ({ ...account })),
    limits: fixtureLimits.map((row) => ({ ...row })),
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
