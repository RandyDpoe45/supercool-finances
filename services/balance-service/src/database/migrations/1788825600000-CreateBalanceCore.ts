import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Money spine (spec 04, step 1): the FK-self-contained core of the balance schema —
 * `currency`, `account`, `external_payee`, `transaction`, `ledger_entry` — plus the native
 * Postgres enum types they use. Tables are created in FK dependency order; `down()` drops
 * them in reverse and removes the enum types.
 *
 * Notes tied to the data model (specs/DATA-MODEL.md, specs/balance-schema.yaml):
 * - Money is `bigint` minor units + a `currency` code (FK -> currency.code). MXN is seeded
 *   here; adding a currency is a data insert, not a migration.
 * - `account` has NO blanket `balance >= 0` check (clearing accounts may go negative);
 *   `held >= 0` IS enforced. Overdraft is a debit-time check, not a DB constraint.
 * - `ledger_entry.created_at` defaults to `clock_timestamp()` (the real insert instant, not
 *   transaction start) — the per-account reconstruction ordering key.
 * - `ledger_entry` append-only is CONVENTION-only at this step: no trigger/REVOKE guard (the
 *   service owns the schema, so a REVOKE would be meaningless). DB-level enforcement is a
 *   deliberately deferred hardening step. See docs/persistence.md.
 * - `gen_random_uuid()` is Postgres core (>= 13) — no extension needed.
 */
export class CreateBalanceCore1788825600000 implements MigrationInterface {
  name = 'CreateBalanceCore1788825600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Native enum types (names + labels match DATA-MODEL "Enumerations") ---
    await queryRunner.query(`CREATE TYPE "account_kind" AS ENUM ('customer', 'system')`);
    await queryRunner.query(`CREATE TYPE "account_status" AS ENUM ('active', 'frozen')`);
    await queryRunner.query(
      `CREATE TYPE "transaction_type" AS ENUM ('internal', 'external_outbound', 'external_inbound')`,
    );
    await queryRunner.query(
      `CREATE TYPE "transaction_status" AS ENUM ('PENDING', 'POSTED', 'FAILED', 'REVERSED')`,
    );
    await queryRunner.query(`CREATE TYPE "payee_status" AS ENUM ('pending', 'active', 'disabled')`);

    // --- currency (reference/lookup; seeds MXN) ---
    await queryRunner.query(`
      CREATE TABLE "currency" (
        "code" char(3) PRIMARY KEY,
        "name" varchar NOT NULL,
        "minor_unit_scale" smallint NOT NULL,
        "symbol" varchar
      )
    `);
    await queryRunner.query(`
      INSERT INTO "currency" ("code", "name", "minor_unit_scale", "symbol")
      VALUES ('MXN', 'Mexican Peso', 2, '$')
    `);

    // --- account (the row every money op locks FOR UPDATE) ---
    await queryRunner.query(`
      CREATE TABLE "account" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "owner_id" varchar,
        "kind" "account_kind" NOT NULL,
        "system_key" varchar,
        "currency" char(3) NOT NULL,
        "status" "account_status" NOT NULL DEFAULT 'active',
        "balance" bigint NOT NULL DEFAULT 0,
        "held" bigint NOT NULL DEFAULT 0,
        "spent_today" bigint NOT NULL DEFAULT 0,
        "spent_today_date" date NOT NULL,
        "spent_month" bigint NOT NULL DEFAULT 0,
        "spent_month_date" date NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_account_held_nonneg" CHECK ("held" >= 0),
        CONSTRAINT "fk_account_currency" FOREIGN KEY ("currency") REFERENCES "currency" ("code")
      )
    `);
    // Owner lookup for customer accounts; system-key uniqueness for clearing accounts.
    await queryRunner.query(
      `CREATE INDEX "idx_account_owner" ON "account" ("owner_id") WHERE "kind" = 'customer'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_account_system_key" ON "account" ("system_key") WHERE "kind" = 'system'`,
    );

    // --- external_payee (cooling-off gate) ---
    await queryRunner.query(`
      CREATE TABLE "external_payee" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "owner_id" varchar NOT NULL,
        "display_name" varchar NOT NULL,
        "rail" varchar NOT NULL,
        "destination_ref" varchar NOT NULL,
        "status" "payee_status" NOT NULL DEFAULT 'pending',
        "cooling_off_until" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "activated_at" timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payee" ON "external_payee" ("owner_id", "rail", "destination_ref")`,
    );

    // --- transaction (header grouping the ledger legs; "transaction" is a keyword — quoted) ---
    await queryRunner.query(`
      CREATE TABLE "transaction" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type" "transaction_type" NOT NULL,
        "status" "transaction_status" NOT NULL,
        "amount" bigint NOT NULL,
        "currency" char(3) NOT NULL,
        "debit_account_id" uuid,
        "credit_account_id" uuid,
        "payee_id" uuid,
        "reverses_transaction_id" uuid,
        "initiated_by" varchar NOT NULL,
        "failure_reason" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "posted_at" timestamptz,
        "failed_at" timestamptz,
        CONSTRAINT "fk_tx_debit_account" FOREIGN KEY ("debit_account_id") REFERENCES "account" ("id"),
        CONSTRAINT "fk_tx_credit_account" FOREIGN KEY ("credit_account_id") REFERENCES "account" ("id"),
        CONSTRAINT "fk_tx_payee" FOREIGN KEY ("payee_id") REFERENCES "external_payee" ("id"),
        CONSTRAINT "fk_tx_reverses" FOREIGN KEY ("reverses_transaction_id") REFERENCES "transaction" ("id"),
        CONSTRAINT "fk_tx_currency" FOREIGN KEY ("currency") REFERENCES "currency" ("code")
      )
    `);
    // Per-account transaction history: GET /accounts/:id/transactions.
    await queryRunner.query(
      `CREATE INDEX "idx_tx_account" ON "transaction" ("debit_account_id", "created_at")`,
    );

    // --- ledger_entry (append-only source of truth; created_at = clock_timestamp) ---
    await queryRunner.query(`
      CREATE TABLE "ledger_entry" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "transaction_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "delta" bigint NOT NULL,
        "balance_after" bigint NOT NULL,
        "currency" char(3) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "fk_ledger_transaction" FOREIGN KEY ("transaction_id") REFERENCES "transaction" ("id"),
        CONSTRAINT "fk_ledger_account" FOREIGN KEY ("account_id") REFERENCES "account" ("id"),
        CONSTRAINT "fk_ledger_currency" FOREIGN KEY ("currency") REFERENCES "currency" ("code")
      )
    `);
    // Per-account ledger fold + reconstruction order.
    await queryRunner.query(
      `CREATE INDEX "idx_ledger_account_created" ON "ledger_entry" ("account_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse FK dependency order; DROP TABLE removes its own indexes/constraints.
    await queryRunner.query(`DROP TABLE "ledger_entry"`);
    await queryRunner.query(`DROP TABLE "transaction"`);
    await queryRunner.query(`DROP TABLE "external_payee"`);
    await queryRunner.query(`DROP TABLE "account"`);
    await queryRunner.query(`DROP TABLE "currency"`);

    await queryRunner.query(`DROP TYPE "payee_status"`);
    await queryRunner.query(`DROP TYPE "transaction_status"`);
    await queryRunner.query(`DROP TYPE "transaction_type"`);
    await queryRunner.query(`DROP TYPE "account_status"`);
    await queryRunner.query(`DROP TYPE "account_kind"`);
  }
}
