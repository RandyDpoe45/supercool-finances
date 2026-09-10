import { DeepPartial, QueryRunner } from 'typeorm';
import { HoldStatus } from '../../entities/enums';
import { Hold } from '../../entities/hold.entity';

/** DI token for {@link IHoldRepository}. */
export const HOLD_REPOSITORY = Symbol('HOLD_REPOSITORY');

/**
 * Persistence port for {@link Hold} — the append-only reservation ledger for in-flight external
 * outbound funds. A hold is `PLACED` at initiate (reserving `account.held`), then transitions
 * ONCE to a terminal state: `SETTLED` at confirm (the money posted), or `RELEASED` / `EXPIRED`
 * on cancel / supersede / TTL-lapse (the reservation returned). Only `PLACED` holds count toward
 * `account.held`, so the guarded transitions below are what keep `SUM(PLACED) == account.held`.
 * Each mutation runs inside the transfers service's single locked, deadlock-retried transaction
 * (`…InTx`), alongside the matching `account.held` update, under the source's `FOR UPDATE` lock.
 */
export interface IHoldRepository {
  findById(id: string): Promise<Hold | null>;
  create(data: DeepPartial<Hold>): Promise<Hold>;
  /** Insert a `PLACED` hold inside the caller's transaction. The caller presets `id` (so this can
   * only ever INSERT) and supplies `accountId` / `transactionId` / `amount` / `rail` / `expiresAt`;
   * `status` defaults `PLACED`. Returns the inserted row (DB-generated columns merged). */
  insertInTx(queryRunner: QueryRunner, data: DeepPartial<Hold>): Promise<Hold>;
  /** The (single) hold backing a transaction, read inside the caller's transaction so it sees the
   * tx's own uncommitted writes. A PENDING external_outbound transfer has exactly one hold. */
  findByTransactionInTx(queryRunner: QueryRunner, transactionId: string): Promise<Hold | null>;
  /** Guarded `PLACED → SETTLED` (+ `settled_at = now()`) inside the caller's transaction:
   * `WHERE id = :id AND status = 'PLACED'`. Returns `true` iff exactly one row flipped; `false`
   * (0 rows) means the hold was already terminal (concurrently released/expired/settled). */
  settleInTx(queryRunner: QueryRunner, id: string): Promise<boolean>;
  /** Guarded `PLACED → <status>` (+ `released_at = now()`) inside the caller's transaction, where
   * `status` is `RELEASED` (cancel / supersede) or `EXPIRED` (TTL lapse): `WHERE id = :id AND
   * status = 'PLACED'`. Returns `true` iff exactly one row flipped; `false` means already terminal.
   * The caller decrements `account.held` ONLY when this returns `true` (never double-decrement). */
  releaseInTx(
    queryRunner: QueryRunner,
    id: string,
    status: HoldStatus.Released | HoldStatus.Expired,
  ): Promise<boolean>;
  /** Record the rail `external_ref` on a settled hold inside the caller's transaction — the
   * reconciliation of a rail SUCCESS callback: `UPDATE ... SET external_ref = :externalRef
   * WHERE id = :id AND external_ref IS NULL`. The `external_ref IS NULL` predicate is the atomic
   * idempotency gate: a retried/duplicate SUCCESS callback finds it already set → 0 rows → a
   * no-op (never overwritten). Returns `true` iff exactly one row was updated. This writes NO
   * ledger and touches no balance/`held` — the money already moved (customer → clearing) at
   * OTP-confirm; this only stamps the rail reference for reconciliation. MUST run inside the
   * given queryRunner's active transaction. */
  recordExternalRefInTx(
    queryRunner: QueryRunner,
    id: string,
    externalRef: string,
  ): Promise<boolean>;
}
