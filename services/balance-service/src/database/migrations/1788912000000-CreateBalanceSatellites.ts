import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Balance schema satellites (spec 04, step 2): the six tables that hang off the money spine
 * created by CreateBalanceCore — `hold`, `user_limits`, `outbox_event`, `audit_log`,
 * `approval_request`, `idempotency_key` — plus the native Postgres enum types they use.
 * Every FK points to a Step-1 table (`account`, `transaction`, `currency`) or to nothing
 * (`audit_log`), so the six can be created in any internal order; `down()` drops the tables
 * then the enum types (a clean inverse).
 *
 * Notes tied to the data model (specs/DATA-MODEL.md, specs/balance-schema.yaml):
 * - `hold.amount > 0` (chk); only PLACED holds count toward `account.held` — reconciliation
 *   query `SUM(amount) WHERE status='PLACED'` per account is backed by a partial index.
 * - `user_limits` uses `UNIQUE NULLS NOT DISTINCT (scope, owner_id)` (Postgres 16) so the
 *   single global row (owner_id NULL) is enforced — a plain unique treats NULLs as distinct
 *   and would let multiple global rows through, defeating the "one global row" intent.
 * - `idempotency_key` has a COMPOSITE PK `(owner_id, key)` — a key is unique per caller.
 * - `audit_log.id` is `bigint GENERATED ALWAYS AS IDENTITY`. Append-only is CONVENTION-only
 *   at this step (no trigger/REVOKE — the service owns the schema); same deferred-hardening
 *   posture as `ledger_entry`. See docs/persistence.md.
 * - Money stays `bigint` minor units; `gen_random_uuid()` is Postgres core (no extension).
 */
export class CreateBalanceSatellites1788912000000 implements MigrationInterface {
  name = 'CreateBalanceSatellites1788912000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Native enum types (names + labels match DATA-MODEL "Enumerations") ---
    await queryRunner.query(
      `CREATE TYPE "hold_status" AS ENUM ('PLACED', 'SETTLED', 'RELEASED', 'EXPIRED')`,
    );
    await queryRunner.query(`CREATE TYPE "user_limits_scope" AS ENUM ('global', 'customer')`);
    await queryRunner.query(
      `CREATE TYPE "approval_action" AS ENUM ('reversal', 'user_limits_change', 'adjustment')`,
    );
    await queryRunner.query(
      `CREATE TYPE "approval_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED')`,
    );
    await queryRunner.query(
      `CREATE TYPE "idempotency_status" AS ENUM ('in_progress', 'completed')`,
    );

    // --- hold (reservation ledger; only PLACED counts toward account.held) ---
    await queryRunner.query(`
      CREATE TABLE "hold" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "account_id" uuid NOT NULL,
        "transaction_id" uuid NOT NULL,
        "amount" bigint NOT NULL,
        "status" "hold_status" NOT NULL DEFAULT 'PLACED',
        "rail" varchar NOT NULL,
        "external_ref" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "settled_at" timestamptz,
        "released_at" timestamptz,
        CONSTRAINT "chk_hold_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "fk_hold_account" FOREIGN KEY ("account_id") REFERENCES "account" ("id"),
        CONSTRAINT "fk_hold_transaction" FOREIGN KEY ("transaction_id") REFERENCES "transaction" ("id")
      )
    `);
    // Backs the held-sum reconciliation/lookup: active holds per account.
    await queryRunner.query(
      `CREATE INDEX "idx_hold_account_placed" ON "hold" ("account_id") WHERE "status" = 'PLACED'`,
    );

    // --- user_limits (global baseline + per-customer override) ---
    await queryRunner.query(`
      CREATE TABLE "user_limits" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "scope" "user_limits_scope" NOT NULL,
        "owner_id" varchar,
        "currency" char(3) NOT NULL,
        "per_transaction_max" bigint,
        "daily_max" bigint,
        "monthly_max" bigint,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_user_limits_scope" UNIQUE NULLS NOT DISTINCT ("scope", "owner_id"),
        CONSTRAINT "fk_user_limits_currency" FOREIGN KEY ("currency") REFERENCES "currency" ("code")
      )
    `);

    // --- outbox_event (transactional outbox; id IS the event_id) ---
    await queryRunner.query(`
      CREATE TABLE "outbox_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "transaction_id" uuid NOT NULL,
        "event_type" varchar NOT NULL,
        "payload" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "published_at" timestamptz,
        CONSTRAINT "fk_outbox_transaction" FOREIGN KEY ("transaction_id") REFERENCES "transaction" ("id")
      )
    `);
    // Relay poll: unpublished rows in creation order (FOR UPDATE SKIP LOCKED).
    await queryRunner.query(
      `CREATE INDEX "idx_outbox_unpublished" ON "outbox_event" ("created_at") WHERE "published_at" IS NULL`,
    );

    // --- audit_log (immutable admin-action log; identity PK; append-only by convention) ---
    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        "actor_id" varchar NOT NULL,
        "action" varchar NOT NULL,
        "target_type" varchar,
        "target_id" varchar,
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // --- approval_request (maker-checker four-eyes) ---
    await queryRunner.query(`
      CREATE TABLE "approval_request" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "action_type" "approval_action" NOT NULL,
        "payload" jsonb NOT NULL,
        "status" "approval_status" NOT NULL DEFAULT 'PENDING',
        "maker_id" varchar NOT NULL,
        "checker_id" varchar,
        "target_transaction_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "decided_at" timestamptz,
        "executed_at" timestamptz,
        CONSTRAINT "chk_approval_four_eyes" CHECK ("checker_id" IS NULL OR "checker_id" <> "maker_id"),
        CONSTRAINT "fk_approval_target_transaction" FOREIGN KEY ("target_transaction_id") REFERENCES "transaction" ("id")
      )
    `);

    // --- idempotency_key (replay safety; composite PK (owner_id, key)) ---
    await queryRunner.query(`
      CREATE TABLE "idempotency_key" (
        "owner_id" varchar NOT NULL,
        "key" varchar NOT NULL,
        "request_fingerprint" varchar NOT NULL,
        "transaction_id" uuid,
        "status" "idempotency_status" NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        CONSTRAINT "pk_idempotency_key" PRIMARY KEY ("owner_id", "key"),
        CONSTRAINT "fk_idem_transaction" FOREIGN KEY ("transaction_id") REFERENCES "transaction" ("id")
      )
    `);
    // Cleanup sweep by expiry; soft duplicate-suppression lookup by (owner, fingerprint, time).
    await queryRunner.query(`CREATE INDEX "idx_idem_expires" ON "idempotency_key" ("expires_at")`);
    await queryRunner.query(
      `CREATE INDEX "idx_idem_fingerprint" ON "idempotency_key" ("owner_id", "request_fingerprint", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DROP TABLE removes each table's own indexes/constraints; none of the six reference
    // each other, so table drop order is free.
    await queryRunner.query(`DROP TABLE "idempotency_key"`);
    await queryRunner.query(`DROP TABLE "approval_request"`);
    await queryRunner.query(`DROP TABLE "audit_log"`);
    await queryRunner.query(`DROP TABLE "outbox_event"`);
    await queryRunner.query(`DROP TABLE "user_limits"`);
    await queryRunner.query(`DROP TABLE "hold"`);

    await queryRunner.query(`DROP TYPE "idempotency_status"`);
    await queryRunner.query(`DROP TYPE "approval_status"`);
    await queryRunner.query(`DROP TYPE "approval_action"`);
    await queryRunner.query(`DROP TYPE "user_limits_scope"`);
    await queryRunner.query(`DROP TYPE "hold_status"`);
  }
}
