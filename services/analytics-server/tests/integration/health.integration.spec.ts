/**
 * DoD (spec 03): "/internal/health responds and is used by the compose healthcheck",
 * plus the Step-3b contract: readiness pings Mongo (503 on failure) and GET
 * /internal/health is EXEMPT from the service-token guard. Analytics has NO
 * migration-on-boot (that is a balance-service concern) — the readiness proof here is
 * that the REAL health repository actually connects to the REAL compose Mongo.
 *
 * This is genuinely DB/Docker-dependent, so it follows the repo's honest-SKIP
 * discipline (see tests/storage/README.md): the suite is OPT-IN via
 * ANALYTICS_INTEGRATION=1 (so a default `npm test` reports it as SKIPPED — never a
 * false pass), and when opted in it asserts Mongo is actually reachable before
 * booting (fail LOUDLY otherwise, never silently degrade). A skip is visible in Jest
 * output; it never counts as a pass.
 *
 * Why this adds value over the deterministic health e2e: that suite fakes the Mongo
 * ping. Here the REAL repository runs, so a 200 means the concrete Mongo-ping
 * readiness path actually connected to a live Mongo — which the fake cannot prove.
 *
 * To run:
 *   1. bring up the compose datastores (mongo reachable to the test runner);
 *   2. export the analytics service's MONGO_* env (or rely on defaults below);
 *   3. ANALYTICS_INTEGRATION=1 npm test
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { getAppModule, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';

const ENABLED = process.env.ANALYTICS_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED health suite: set ANALYTICS_INTEGRATION=1 (and point ' +
      'MONGO_HOST/MONGO_PORT/MONGO_USER/MONGO_PASSWORD/MONGO_DB/MONGO_AUTH_SOURCE at a ' +
      'reachable Mongo) to run it.',
  );
}

const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1';
const MONGO_PORT = Number(process.env.MONGO_PORT || '27017');

// describe.skip when not opted in -> tests show as skipped, not passed.
const suite = ENABLED ? describe : describe.skip;

suite('health (integration, needs Mongo)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const reachable = await tcpProbe(MONGO_HOST, MONGO_PORT);
    if (!reachable) {
      throw new Error(
        `[integration] ANALYTICS_INTEGRATION=1 but Mongo is not reachable at ` +
          `${MONGO_HOST}:${MONGO_PORT}. Bring up the compose datastores (and publish/point ` +
          `MONGO_HOST/MONGO_PORT at them) or unset ANALYTICS_INTEGRATION.`,
      );
    }

    // Provide a full, valid config pointing at the reachable Mongo. Missing keys fall
    // back to the shared fixture; the runner's real MONGO_* env takes precedence.
    const env = completeRawEnv({
      MONGO_HOST,
      MONGO_PORT: String(MONGO_PORT),
      MONGO_DB: process.env.MONGO_DB || 'analytics',
      MONGO_USER: process.env.MONGO_USER || 'analytics_app',
      MONGO_PASSWORD: process.env.MONGO_PASSWORD || 'changeme-analytics-local',
      MONGO_AUTH_SOURCE: process.env.MONGO_AUTH_SOURCE || 'analytics',
      INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-service-token',
    });
    for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

    const AppModule = getAppModule();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // establishes the real Mongo connection on boot
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('GET /internal/health is reachable WITHOUT a service token (carve-out) and reports 200 when Mongo is up', async () => {
    const res = await request(app.getHttpServer()).get('/internal/health');
    // The carve-out: never 401 (the rest of /internal requires the service token).
    expect(res.status).not.toBe(401);
    // Readiness pings Mongo via the REAL repository; Mongo is reachable here, so
    // readiness passes -> 200. (503 would be the readiness-failure signal.) A 200 from
    // the real repo proves the concrete Mongo-ping path actually connected.
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    expect(typeof res.body).toBe('object');
    expect(res.body.readiness).toBe('up');
  });

  it('a non-health /internal route still requires the service token even against the real app (401)', async () => {
    // Locks the carve-out as specific to health, exercised against the fully-booted
    // AppModule (not the minimal test module).
    const res = await request(app.getHttpServer()).get('/internal/ping');
    expect(res.status).toBe(401);
  });
});
