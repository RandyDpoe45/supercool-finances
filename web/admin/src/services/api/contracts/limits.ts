/**
 * App-local copy of the balance-service admin limits wire contract (`GET /admin/limits`,
 * `PUT /admin/limits`). Per ADR-16 the admin-app keeps its own copy, kept in sync via
 * specs/07-frontends.md — the contract of record.
 *
 * A limits row is either the GLOBAL baseline (`scope: 'global'`, `ownerId: null`) or a per-customer
 * OVERRIDE (`scope: 'customer'`, `ownerId` set). The three caps are UNSIGNED minor-unit INTEGER
 * strings (e.g. `'150000'` = 1500.00 MXN) or `null` (uncapped) — NEVER a JS number; parsing one
 * into a float is a money-safety defect. `createdAt`/`updatedAt` are ISO-8601 UTC instants.
 */
export interface LimitsDto {
  id: string;
  scope: string;
  ownerId: string | null;
  currency: string;
  perTransactionMax: string | null;
  dailyMax: string | null;
  monthlyMax: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Envelope returned by `GET /admin/limits`. */
export interface LimitsResponse {
  limits: LimitsDto[];
}

/** Scope of a limits row: the system-wide baseline, or a single-customer override. */
export type LimitsScope = 'global' | 'customer';

/**
 * Body of `PUT /admin/limits` (upsert). Business rule (enforced client-side AND by the stub, as by
 * the real controller): `global` ⇒ `ownerId` MUST be absent/null; `customer` ⇒ `ownerId` REQUIRED.
 * A violation is `400 INVALID_LIMITS`. Each cap is an unsigned minor-unit integer string, or
 * `null`/omitted (uncapped) — never a number.
 */
export interface UpsertLimitsBody {
  scope: LimitsScope;
  ownerId?: string | null;
  currency: string;
  perTransactionMax?: string | null;
  dailyMax?: string | null;
  monthlyMax?: string | null;
}
