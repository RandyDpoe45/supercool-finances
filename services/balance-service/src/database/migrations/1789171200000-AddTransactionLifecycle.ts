import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pending-authorization lifecycle (spec 04 Transfers, "Pending authorization is single and
 * time-boxed"): the two terminal labels a pending transfer can reach without posting, the
 * 2-minute expiry marker, and the single-pending-per-user invariant enforced in the DB.
 *
 * - `transaction_status` gains **`EXPIRED`** and **`CANCELLED`** (a pending transfer that lapses
 *   past its `expires_at`, and one auto-superseded by a new initiate or cancelled by the user —
 *   both retained for compliance, never deleted).
 * - `transaction.expires_at` (`timestamptz NULL`): the pending deadline set FROM THE DB CLOCK at
 *   initiate (`now() + 2 minutes`). Nullable — only user-initiated PENDING transfers carry one.
 *   Lazy expiry compares it against `now()` on the next access; there is **no scheduler**.
 * - `uq_one_pending_per_initiator`: a **partial** unique index on `initiated_by WHERE status =
 *   'PENDING'`, so a user can hold at most ONE live pending transfer while accumulating any number
 *   of terminal ones. This backs the single-pending rule structurally, not just via a service
 *   check, and is the concurrency backstop against a double-initiate race (→ 23505 → 409).
 *
 * PG note (ADD VALUE inside the migration transaction): on Postgres 12+ (this deployment is PG 16)
 * `ALTER TYPE ... ADD VALUE` is permitted inside the migration's transaction ONLY because the new
 * labels are NOT USED in this same migration — the index predicate references the pre-existing
 * `'PENDING'`. Keep it that way; a future migration that must USE 'EXPIRED'/'CANCELLED' in DDL/DML
 * has to run in a separate, later migration (its own transaction).
 */
export class AddTransactionLifecycle1789171200000 implements MigrationInterface {
  name = 'AddTransactionLifecycle1789171200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Two new terminal labels on the existing native enum. Safe inside this transaction because
    // neither is USED below (the index predicate uses the pre-existing 'PENDING'); IF NOT EXISTS
    // keeps the migration idempotent on re-run.
    await queryRunner.query(`ALTER TYPE "transaction_status" ADD VALUE IF NOT EXISTS 'EXPIRED'`);
    await queryRunner.query(`ALTER TYPE "transaction_status" ADD VALUE IF NOT EXISTS 'CANCELLED'`);

    // The 2-minute pending deadline marker (nullable — only PENDING transfers carry one).
    await queryRunner.query(`ALTER TABLE "transaction" ADD COLUMN "expires_at" timestamptz NULL`);

    // At most one PENDING transfer per initiator — a PARTIAL unique index (structural, not just a
    // service check). Terminal rows are excluded, so an initiator may retain any number of
    // POSTED/EXPIRED/CANCELLED transfers but only ever one live PENDING.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_one_pending_per_initiator" ON "transaction" ("initiated_by") WHERE "status" = 'PENDING'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_one_pending_per_initiator"`);
    await queryRunner.query(`ALTER TABLE "transaction" DROP COLUMN "expires_at"`);
    // Postgres cannot DROP a value from an enum type, so the 'EXPIRED' / 'CANCELLED' labels added
    // by up() remain on `transaction_status` after down(). They are harmless (unused once the
    // column/index are gone) and down() intentionally does NOT attempt to remove them — there is
    // no safe DDL to drop an enum label in-place.
  }
}
