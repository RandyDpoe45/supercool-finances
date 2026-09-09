import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seeds the two per-rail clearing accounts (spec 04: `clearing:rail-outbound`,
 * `clearing:rail-inbound`). These are SYSTEM CONSTANTS the service needs to run — the
 * accounting counter-leg for external money — so, like the MXN `currency` row (seeded by
 * CreateBalanceCore), they live in a migration that runs on boot, NOT in tools/seed.
 *
 * Scope guard: this seeds ONLY the system/clearing accounts. Global/default `user_limits`
 * and any customer/demo data are deliberately NOT seeded here — those belong to spec 08 /
 * tools/seed. MXN currency is already seeded by CreateBalanceCore and is not re-inserted.
 *
 * Idempotent: `ON CONFLICT ("system_key") WHERE "kind" = 'system'` targets the partial
 * unique index `uq_account_system_key`, so a re-run inserts nothing. `spent_today_date` /
 * `spent_month_date` are NOT NULL without a DB default, so they are supplied here (the
 * fixed-window markers: today, and first-of-month); balance/held/spend counters default to
 * 0 and status defaults to 'active'.
 */
export class SeedSystemAccounts1788998400000 implements MigrationInterface {
  name = 'SeedSystemAccounts1788998400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "account" ("kind", "owner_id", "currency", "system_key", "spent_today_date", "spent_month_date")
      VALUES
        ('system', NULL, 'MXN', 'clearing:rail-outbound', CURRENT_DATE, date_trunc('month', CURRENT_DATE)::date),
        ('system', NULL, 'MXN', 'clearing:rail-inbound', CURRENT_DATE, date_trunc('month', CURRENT_DATE)::date)
      ON CONFLICT ("system_key") WHERE "kind" = 'system' DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "account"
      WHERE "kind" = 'system'
        AND "system_key" IN ('clearing:rail-outbound', 'clearing:rail-inbound')
    `);
  }
}
