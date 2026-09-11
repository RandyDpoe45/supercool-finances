import { DeepPartial, QueryRunner } from 'typeorm';
import { UserLimitsScope } from '../../entities/enums';
import { UserLimits } from '../../entities/user-limits.entity';

/** DI token for {@link IUserLimitsRepository}. */
export const USER_LIMITS_REPOSITORY = Symbol('USER_LIMITS_REPOSITORY');

/** Filter for the admin limits query ({@link IUserLimitsRepository.list}). Both fields optional
 * (absent → no predicate on that column). No paging — limits rows are few. */
export interface UserLimitsListFilter {
  scope?: UserLimitsScope;
  ownerId?: string;
}

/** The three resolved caps for an owner + currency (each `null` = uncapped for that field). */
export interface ResolvedLimits {
  perTransactionMax: string | null;
  dailyMax: string | null;
  monthlyMax: string | null;
}

/** The fully-resolved row to upsert (admin `PUT /limits`). `ownerId` is NULL for a global row.
 * Each cap is a canonical minor-unit string or `null` (uncapped for that field). */
export interface UpsertUserLimitsData {
  scope: UserLimitsScope;
  ownerId: string | null;
  currency: string;
  perTransactionMax: string | null;
  dailyMax: string | null;
  monthlyMax: string | null;
}

/** Persistence port for {@link UserLimits} (owner-scoped override rows). Global/customer
 * resolution logic is a domain-step concern. */
export interface IUserLimitsRepository {
  findById(id: string): Promise<UserLimits | null>;
  create(data: DeepPartial<UserLimits>): Promise<UserLimits>;
  /** Customer-scope limit rows for a customer (`owner_id`); global rows have `owner_id` NULL. */
  findByOwner(ownerId: string): Promise<UserLimits[]>;
  /** Admin-scoped limits query (spec 04 "Admin ops" — `GET /limits`, view ANY limits row). A
   * parameterized SELECT with the optional `scope` / `ownerId` filters bound, `ORDER BY created_at
   * DESC` (id tiebreak for determinism). No `FOR UPDATE`, no paging (limits rows are few). This is
   * a plain read for the role-gated admin surface. */
  list(filter: UserLimitsListFilter): Promise<UserLimits[]>;
  /**
   * Resolve the caps that apply to an owner + currency, inside the caller's transaction (joined
   * to the reducer's account-lock critical section). Row-level, customer-wins resolution: the
   * `customer` row (`owner_id = :ownerId`) wins wholesale when present, else the `global` row,
   * else `null` (uncapped). A NULL cap field inside the returned row is uncapped for that field.
   */
  resolveInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    currency: string,
  ): Promise<ResolvedLimits | null>;
  /**
   * Read the EXACT row for `(scope, ownerId, currency)` inside the caller's transaction — the
   * before-image for an admin `PUT /limits` upsert. A global row has `owner_id IS NULL`, so a
   * `null` `ownerId` matches only the global row (never a customer override). Returns `null` when
   * no such row exists yet (the upsert will INSERT one). Full entity (not just caps), so the audit
   * before-image is complete.
   */
  findExactInTx(
    queryRunner: QueryRunner,
    scope: UserLimitsScope,
    ownerId: string | null,
    currency: string,
  ): Promise<UserLimits | null>;
  /**
   * Upsert the limits row for `(scope, owner_id)` inside the caller's transaction:
   * `INSERT ... ON CONFLICT ON CONSTRAINT "uq_user_limits_scope" DO UPDATE SET the caps, currency,
   * updated_at = now()`. The unique constraint is `(scope, owner_id)` (NULLS NOT DISTINCT, so the
   * single global row is enforced), so this is one row per scope/owner. Returns the inserted/updated
   * row (`RETURNING *`). MUST run inside the caller's active transaction (the same tx as the audit
   * row).
   */
  upsertInTx(queryRunner: QueryRunner, data: UpsertUserLimitsData): Promise<UserLimits>;
}
