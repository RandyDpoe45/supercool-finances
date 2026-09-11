import type { AccountSummaryDto, DailyAggregateDto } from '../../services/api/contracts/analytics';
import { fixtureAccountSummaries, fixtureDailyAggregates } from '../fixtures/analytics';

/**
 * Read-only stub state for the analytics reporting surface. Analytics has NO mutations (the read
 * model is derived from the event stream, not written through this API), so unlike `adminState`
 * there is no mutable state, no reset, and no seed clone — these functions read the frozen fixtures
 * directly and return COPIES so a caller can never mutate the seed.
 *
 * Filters are exact-match; paging mirrors the server clamp (`limit` default 50, clamped `[1, 200]`;
 * `offset ≥ 0`). Money stays a minor-unit STRING throughout — never parsed to a float. Fixture
 * order is preserved (the contract carries no inherent client-visible ordering guarantee).
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A missing / non-numeric limit falls back to the default (50) before clamping to `[1, 200]`. */
function clampLimit(limit: number | undefined): number {
  const base = Number.isFinite(limit) ? (limit as number) : DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(base), 1), MAX_LIMIT);
}

/** A missing / negative / non-numeric offset clamps to 0. */
function clampOffset(offset: number | undefined): number {
  return Number.isFinite(offset) && (offset ?? 0) > 0 ? (offset as number) : 0;
}

/**
 * Per-account summaries, optionally filtered by exact `ownerId` / `accountId` / `currency`, then
 * paged. Copies are returned so the caller cannot mutate the frozen fixtures.
 */
export function listAccountSummaries(params: {
  ownerId?: string;
  accountId?: string;
  currency?: string;
  limit?: number;
  offset?: number;
}): AccountSummaryDto[] {
  const filtered = fixtureAccountSummaries.filter((row) => {
    if (params.ownerId && row.ownerId !== params.ownerId) {
      return false;
    }
    if (params.accountId && row.accountId !== params.accountId) {
      return false;
    }
    if (params.currency && row.currency !== params.currency) {
      return false;
    }
    return true;
  });
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);
  return filtered.slice(offset, offset + limit).map((row) => ({ ...row }));
}

/**
 * Daily aggregates, optionally filtered by exact `currency` / `type` and an inclusive `from`/`to`
 * day window, then paged. `from`/`to` are `YYYY-MM-DD` day strings — a row is included when
 * `date >= from` and `date <= to` (a lexicographic compare, which is valid for the fixed-width
 * `YYYY-MM-DD` shape). Copies are returned.
 */
export function listDailyAggregates(params: {
  currency?: string;
  type?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): DailyAggregateDto[] {
  const filtered = fixtureDailyAggregates.filter((row) => {
    if (params.currency && row.currency !== params.currency) {
      return false;
    }
    if (params.type && row.type !== params.type) {
      return false;
    }
    if (params.from && row.date < params.from) {
      return false;
    }
    if (params.to && row.date > params.to) {
      return false;
    }
    return true;
  });
  const limit = clampLimit(params.limit);
  const offset = clampOffset(params.offset);
  return filtered.slice(offset, offset + limit).map((row) => ({ ...row }));
}
