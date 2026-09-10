/**
 * Spec 04 — Balance Service, STEP 7: the SEEDED GLOBAL LIMITS BASELINE (a migration seed, like the
 * system/clearing accounts). Written FROM the spec's "Limits" bullet ("The global baseline is
 * seeded (migration, like the system accounts)") + the developer-locked caps, NOT from the
 * implementor's code:
 *
 *   - The migration seeds EXACTLY ONE `user_limits` row with `scope='global'`, `owner_id` NULL,
 *     `currency='MXN'`, and the caps per_transaction_max=5,000,000 / daily_max=10,000,000 /
 *     monthly_max=100,000,000 (minor units).
 *   - Re-running is safe: the `uq_user_limits_scope (scope, owner_id)` unique is NULLS NOT DISTINCT
 *     (Postgres 16), so a SECOND global row (owner_id NULL) is rejected (23505) — the single-global
 *     invariant is DB-enforced, not merely convention.
 *
 * The seed rows are committed by the migration on boot, so they are asserted READ-ONLY. The
 * uniqueness proof runs inside an always-rolled-back transaction (so it leaves nothing behind).
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (default `npm test` reports SKIPPED). beforeAll
 * TCP-probes Postgres and boots the real AppModule (migrationsRun:true).
 *
 * To run:  BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=…] npm test
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { getAppModule, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import { PG, withRollback, insertRow, expectPgError } from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED limits-seed suite: set BALANCE_INTEGRATION=1 (point DB_* at Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

// Developer-locked seeded global baseline (MXN, minor units).
const GLOBAL_CAPS = {
  per_transaction_max: '5000000',
  daily_max: '10000000',
  monthly_max: '100000000',
};

const suite = ENABLED ? describe : describe.skip;

suite('limits seed — the migration-seeded global baseline (integration, needs Postgres)', () => {
  let app: INestApplication;
  let ds: any;

  beforeAll(async () => {
    const reachable = await tcpProbe(DB_HOST, DB_PORT);
    if (!reachable) {
      throw new Error(
        `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ${DB_HOST}:${DB_PORT}.`,
      );
    }

    const env = completeRawEnv({
      DB_HOST,
      DB_PORT: String(DB_PORT),
      DB_NAME: process.env.DB_NAME || 'balance',
      DB_USER: process.env.DB_USER || 'balance_app',
      DB_PASSWORD: process.env.DB_PASSWORD || 'changeme-balance-local',
      REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
      REDIS_PORT: process.env.REDIS_PORT || '6379',
      REDIS_PASSWORD: process.env.REDIS_PASSWORD || 'changeme-redis-local',
      INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-service-token',
    });
    for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

    const AppModule = getAppModule();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // runs migrations on boot: MXN + clearing accounts + the global limits seed

    try {
      const { DataSource } = require('typeorm');
      ds = app.get(DataSource);
    } catch {
      const { getDataSourceToken } = require('@nestjs/typeorm');
      ds = app.get(getDataSourceToken());
    }
    if (!ds) throw new Error('[integration] could not resolve the TypeORM DataSource from the app');
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('seeds EXACTLY ONE global user_limits row with the expected caps (MXN, owner_id NULL)', async () => {
    const rows = await ds.query(
      `SELECT owner_id, currency,
              per_transaction_max::text AS per_transaction_max,
              daily_max::text AS daily_max,
              monthly_max::text AS monthly_max
         FROM user_limits WHERE scope = 'global'`,
    );
    expect(rows.length).toBe(1); // exactly one global baseline — never zero, never duplicated
    const row = rows[0];
    expect(row.owner_id).toBeNull(); // the global row is owner-agnostic
    expect(row.currency).toBe('MXN');
    expect(row.per_transaction_max).toBe(GLOBAL_CAPS.per_transaction_max);
    expect(row.daily_max).toBe(GLOBAL_CAPS.daily_max);
    expect(row.monthly_max).toBe(GLOBAL_CAPS.monthly_max);
  });

  it('re-running the seed is safe: a SECOND global row (owner_id NULL) is rejected by the NULLS-NOT-DISTINCT unique (23505)', async () => {
    // A plain UNIQUE would treat the two NULL owner_ids as distinct and ALLOW a second global row;
    // NULLS NOT DISTINCT is what makes "at most one global" DB-enforced. Rolled back either way.
    await withRollback(ds, async (q) => {
      await expectPgError(
        insertRow(q, 'user_limits', {
          scope: 'global',
          owner_id: null,
          currency: 'MXN',
          per_transaction_max: GLOBAL_CAPS.per_transaction_max,
          daily_max: GLOBAL_CAPS.daily_max,
          monthly_max: GLOBAL_CAPS.monthly_max,
        }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });
});
