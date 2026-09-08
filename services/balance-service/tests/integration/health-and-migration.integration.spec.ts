/**
 * DoD (spec 03): "A sample TypeORM migration runs on boot against the `balance` DB"
 * and "/internal/health responds and is used by the compose healthcheck", plus the
 * Step-3a contract: readiness pings Postgres (503 on failure) and GET /internal/health
 * is EXEMPT from the service-token guard.
 *
 * These are genuinely DB/Docker-dependent, so they follow the repo's honest-SKIP
 * discipline (see tests/storage/README.md): the suite is OPT-IN via
 * BALANCE_INTEGRATION=1 (so a default `npm test` reports it as SKIPPED — never a
 * false pass), and when opted in it asserts the datastores are actually reachable
 * before booting. A skip is visible in Jest output; it never counts as a pass.
 *
 * To run:
 *   1. bring up the compose datastores (postgres reachable to the test runner);
 *   2. export the balance service's DB_* env (or rely on defaults below);
 *   3. BALANCE_INTEGRATION=1 npm test
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { getAppModule, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED health+migration suite: set BALANCE_INTEGRATION=1 (and ' +
      'point DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a reachable Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

// describe.skip when not opted in -> tests show as skipped, not passed.
const suite = ENABLED ? describe : describe.skip;

suite('health + migration (integration, needs Postgres)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const reachable = await tcpProbe(DB_HOST, DB_PORT);
    if (!reachable) {
      throw new Error(
        `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ` +
          `${DB_HOST}:${DB_PORT}. Bring up the compose datastores (and publish/point ` +
          `DB_HOST/DB_PORT at them) or unset BALANCE_INTEGRATION.`,
      );
    }

    // Provide a full, valid config pointing at the reachable Postgres. Missing keys
    // fall back to the shared fixture; the runner's real DB_* env takes precedence.
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
    await app.init(); // runs migrations on boot (migrationsRun: true)
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /internal/health is reachable WITHOUT a service token (healthcheck carve-out) and reports 200 when the DB is up', async () => {
    const res = await request(app.getHttpServer()).get('/internal/health');
    // The carve-out: never 401 (the rest of /internal requires the service token).
    expect(res.status).not.toBe(401);
    // Readiness pings Postgres; Postgres is reachable here, so readiness passes -> 200.
    // (503 would be the readiness-failure signal — see the contract.)
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(typeof res.body).toBe('object');
  });

  it('the sample migration actually ran on boot and created a foundation table in `balance`', async () => {
    // Resolve TypeORM's DataSource from the running app to inspect the schema.
    let ds: any;
    try {
      const { DataSource } = require('typeorm');
      ds = app.get(DataSource);
    } catch {
      const { getDataSourceToken } = require('@nestjs/typeorm');
      ds = app.get(getDataSourceToken());
    }
    expect(ds).toBeDefined();

    const rows: Array<{ table_name: string }> = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);

    // Migrations on boot must have created at least one table.
    expect(names.length).toBeGreaterThan(0);

    // TypeORM records executed migrations in a *migrations tracking table; it must
    // exist and hold >=1 row -> proves `migrationsRun: true` executed a migration.
    const migTable = names.find((n) => /migration/i.test(n));
    expect(migTable).toBeDefined();
    const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM "${migTable}"`);
    expect(Number(n)).toBeGreaterThan(0);

    // ...and at least one application (non-tracking) table exists -> the sample
    // "foundation table" the migration was supposed to create.
    const appTables = names.filter((n) => !/migration/i.test(n));
    expect(appTables.length).toBeGreaterThan(0);

    // If the runner names the expected table, assert it specifically.
    if (process.env.SAMPLE_MIGRATION_TABLE) {
      expect(names).toContain(process.env.SAMPLE_MIGRATION_TABLE);
    }
  });
});
