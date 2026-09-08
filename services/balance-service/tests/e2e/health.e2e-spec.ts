/**
 * DoD (spec 03): "/internal/health responds and is used by the compose healthcheck"
 * + Step-3a contract: a body distinguishing liveness vs readiness (readiness pings
 * Postgres), readiness failure => 503, and GET /internal/health EXEMPT from the
 * service-token guard.
 *
 * Runs WITHOUT Docker: it mounts the REAL HealthController and the REAL
 * ServiceIdentityGuard (bound globally, as in AppModule), and fakes ONLY the
 * readiness repository (the seam that pings Postgres). Faking that single external
 * dependency — not the logic under test — lets us exercise both the ready (200) and
 * not-ready (503) branches deterministically, plus the guard carve-out.
 *
 * The real DB-backed readiness + migration-on-boot are proven separately in the
 * honest-SKIP integration suite.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
  resolveGuardsAndFilter,
  getAppConfigToken,
  getHealth,
  getInternalProbeController,
} from '../support/harness';

const { ServiceIdentityGuard } = resolveGuardsAndFilter();
const APP_CONFIG = getAppConfigToken();
const { HealthController, HEALTH_REPOSITORY } = getHealth();
const InternalController = getInternalProbeController();

const SERVICE_TOKEN = 'super-secret-service-token';

describe('/internal/health (real controller + guard, faked DB ping, no Docker)', () => {
  let app: INestApplication;
  // Flip this to drive the readiness branch; the fake repo reads it per request.
  const dbState = { up: true };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, InternalController],
      providers: [
        { provide: APP_GUARD, useClass: ServiceIdentityGuard },
        { provide: APP_CONFIG, useValue: { internalServiceToken: SERVICE_TOKEN } },
        { provide: HEALTH_REPOSITORY, useValue: { checkConnection: async () => dbState.up } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('is reachable WITHOUT a service token (Docker healthcheck carve-out)', async () => {
    dbState.up = true;
    const res = await request(app.getHttpServer()).get('/internal/health');
    expect(res.status).not.toBe(401);
  });

  it('keeps the carve-out on a mixed-case path (/INTERNAL/HEALTH is still exempt, not 401)', async () => {
    // Express routes /INTERNAL/HEALTH to the same handler; the carve-out normalizes
    // case, so it must stay exempt rather than demand a token (regression lock on the
    // case-insensitive prefix + carve-out fix).
    dbState.up = true;
    const res = await request(app.getHttpServer()).get('/INTERNAL/HEALTH');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it('returns 200 with liveness AND readiness both up when the DB is reachable', async () => {
    dbState.up = true;
    const res = await request(app.getHttpServer()).get('/internal/health');
    expect(res.status).toBe(200);
    // The body must distinguish liveness from readiness (contract).
    expect(res.body.liveness).toBe('up');
    expect(res.body.readiness).toBe('up');
    expect(res.body.checks?.db).toBe('up');
  });

  it('returns 503 with readiness DOWN but liveness still UP when the DB is unreachable', async () => {
    dbState.up = false;
    const res = await request(app.getHttpServer()).get('/internal/health');
    expect(res.status).toBe(503);
    // The key distinction: the process is alive, only readiness failed.
    expect(res.body.liveness).toBe('up');
    expect(res.body.readiness).toBe('down');
    expect(res.body.checks?.db).toBe('down');
  });

  it('exempts ONLY health — another /internal route still requires the service token (401)', async () => {
    // Proves the carve-out is specific to health, not a blanket bypass of /internal.
    const res = await request(app.getHttpServer()).get('/internal/ping');
    expect(res.status).toBe(401);
  });

  it('allows a guarded /internal route with the correct service token', async () => {
    const res = await request(app.getHttpServer())
      .get('/internal/ping')
      .set('X-Service-Token', SERVICE_TOKEN);
    expect(res.status).toBe(200);
  });
});
