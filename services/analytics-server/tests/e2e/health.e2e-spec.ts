/**
 * DoD (spec 03): "/internal/health responds and is used by the compose healthcheck"
 * + Step-3b contract: a body distinguishing liveness vs readiness (readiness pings
 * Mongo), readiness failure => 503, and GET /internal/health EXEMPT from the
 * service-token guard.
 *
 * Runs WITHOUT Docker: it mounts the REAL HealthController and the REAL
 * ServiceIdentityGuard (bound globally, as in AppModule), and fakes ONLY the
 * readiness repository (the seam that pings Mongo). Faking that single external
 * dependency — not the logic under test — lets us exercise both the ready (200) and
 * not-ready (503) branches deterministically without Docker, plus the guard carve-out.
 *
 * The real Mongo-backed readiness is proven separately in the honest-SKIP integration
 * suite (tests/integration/health.integration.spec.ts).
 */
import 'reflect-metadata';
import { Controller, Get, INestApplication } from '@nestjs/common';
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

// Test-only controller (test code, not production): a health-PREFIXED but NON-exact
// /internal route with NO self-defense. It exists so the carve-out's exactness is
// proven by a real 401 over the wire — if the guard widened the carve-out to a prefix
// match (`startsWith('/internal/health')`), this route would leak a 200 instead.
@Controller('internal')
class HealthPrefixedProbeController {
  @Get('health-and-secrets')
  probe() {
    return { ok: true };
  }
}

/** The readiness check is exposed under a Mongo-ish key in `checks`; accept the
 *  plausible names so the assertion catches an inverted/dropped check without
 *  over-coupling to one label (see tests/README.md assumptions). */
function mongoCheckOf(body: any): unknown {
  const checks = body?.checks ?? {};
  return checks.mongo ?? checks.mongodb ?? checks.db ?? checks.database;
}

describe('/internal/health (real controller + guard, faked Mongo ping, no Docker)', () => {
  let app: INestApplication;
  // Flip this to drive the readiness branch; the fake repo reads it per request.
  const mongoState = { up: true };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, InternalController, HealthPrefixedProbeController],
      providers: [
        { provide: APP_GUARD, useClass: ServiceIdentityGuard },
        { provide: APP_CONFIG, useValue: { internalServiceToken: SERVICE_TOKEN } },
        { provide: HEALTH_REPOSITORY, useValue: { checkConnection: async () => mongoState.up } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('is reachable WITHOUT a service token (Docker healthcheck carve-out)', async () => {
    mongoState.up = true;
    const res = await request(app.getHttpServer()).get('/internal/health');
    expect(res.status).not.toBe(401);
  });

  it('keeps the carve-out on a mixed-case path (/INTERNAL/HEALTH is still exempt, not 401)', async () => {
    // Express routes /INTERNAL/HEALTH to the same handler; the carve-out normalizes
    // case, so it must stay exempt rather than demand a token (regression lock on the
    // case-insensitive prefix + carve-out).
    mongoState.up = true;
    const res = await request(app.getHttpServer()).get('/INTERNAL/HEALTH');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });

  it('returns 200 with liveness AND readiness both up when Mongo is reachable', async () => {
    mongoState.up = true;
    const res = await request(app.getHttpServer()).get('/internal/health');
    expect(res.status).toBe(200);
    // The body must distinguish liveness from readiness (contract).
    expect(res.body.liveness).toBe('up');
    expect(res.body.readiness).toBe('up');
    expect(mongoCheckOf(res.body)).toBe('up');
  });

  it('returns 503 with readiness DOWN but liveness still UP when Mongo is unreachable', async () => {
    mongoState.up = false;
    const res = await request(app.getHttpServer()).get('/internal/health');
    expect(res.status).toBe(503);
    // The key distinction: the process is alive, only readiness failed.
    expect(res.body.liveness).toBe('up');
    expect(res.body.readiness).toBe('down');
    expect(mongoCheckOf(res.body)).toBe('down');
  });

  it('exempts ONLY health — another /internal route still requires the service token (401)', async () => {
    // Proves the carve-out is specific to health, not a blanket bypass of /internal.
    const res = await request(app.getHttpServer()).get('/internal/ping');
    expect(res.status).toBe(401);
  });

  it('a health-PREFIXED but non-exact /internal path stays guarded (GET /internal/health-and-secrets => 401)', async () => {
    // Exact-match carve-out: `/internal/health` is exempt, but `/internal/health-*`
    // is NOT. The probe route has no self-defense, so a prefix-widened carve-out would
    // surface here as a 200 rather than the required 401.
    const res = await request(app.getHttpServer()).get('/internal/health-and-secrets');
    expect(res.status).toBe(401);
  });

  it('allows a guarded /internal route with the correct service token', async () => {
    const res = await request(app.getHttpServer())
      .get('/internal/ping')
      .set('X-Service-Token', SERVICE_TOKEN);
    expect(res.status).toBe(200);
  });
});
