import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seeds the single GLOBAL baseline `user_limits` row (spec 04 Limits: "the global baseline is
 * seeded, like the system accounts"). Like the MXN `currency` row and the two clearing accounts,
 * the baseline caps are a SYSTEM CONSTANT the service needs to run — every customer-initiated
 * outbound is checked against them until an admin sets a per-customer override — so they live in
 * a boot migration, NOT in tools/seed.
 *
 * Scope guard: this seeds ONLY the one global baseline row (`scope='global'`, `owner_id` NULL).
 * Per-customer override rows (`scope='customer'`) and any demo data are deliberately NOT seeded
 * here — those belong to the admin `PUT /limits` surface / spec 08 tools/seed.
 *
 * Idempotent: `ON CONFLICT ON CONSTRAINT "uq_user_limits_scope" DO NOTHING` targets the
 * `UNIQUE NULLS NOT DISTINCT (scope, owner_id)` constraint (so the single NULL-owner global row
 * is actually enforced), making a re-run a no-op. `id` defaults to `gen_random_uuid()`,
 * timestamps to `now()`.
 *
 * Baseline caps (MXN, minor units): per-transaction 5000000 (50,000.00), daily 10000000
 * (100,000.00), monthly 100000000 (1,000,000.00).
 */
export class SeedBaselineUserLimits1789257600000 implements MigrationInterface {
  name = 'SeedBaselineUserLimits1789257600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "user_limits" ("scope", "owner_id", "currency", "per_transaction_max", "daily_max", "monthly_max")
      VALUES ('global', NULL, 'MXN', '5000000', '10000000', '100000000')
      ON CONFLICT ON CONSTRAINT "uq_user_limits_scope" DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "user_limits"
      WHERE "scope" = 'global'
        AND "owner_id" IS NULL
        AND "currency" = 'MXN'
    `);
  }
}
