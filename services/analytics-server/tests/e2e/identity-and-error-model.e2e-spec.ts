/**
 * DoD (spec 03) + Step-3b coordination contract:
 *   2. Gateway identity guard  (/admin — analytics has NO /api)
 *   3. Service identity guard  (/internal)
 *   4. Case-bypass negatives (guards fail CLOSED on mixed-case prefixes)
 *   5. Error model DTO  (+ requestId correlation, 5xx genericization / no info leak)
 *
 * A MINIMAL NestJS app (no DB, no Docker) that binds the implementor's REAL guards
 * GLOBALLY via APP_GUARD (exactly as AppModule does) and threads the REAL request-id
 * middleware + error filter, then drives it over HTTP with supertest. Because the
 * guards are global (not per-route), this also proves they SELF-SCOPE by prefix —
 * the gateway guard ignores /internal, the service guard ignores /admin — which is
 * the "applied globally per prefix, cannot be skipped" property from the spec.
 *
 * The guards/filter/middleware are the implementor's real code; the probe
 * controllers and test module are scaffolding only (test code, not production — the
 * intended approach per the task). A wrong implementation (trusting a body/query id,
 * forgetting the admin check, wrong status, missing/altered error DTO, dropped
 * correlation id, a case-sensitive prefix check, or a leaky 5xx) fails a test here.
 */
import 'reflect-metadata';
import { Controller, Get, Req, NotFoundException, INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import {
  resolveGuardsAndFilter,
  getAppConfigToken,
  getRequestId,
  getInternalProbeController,
} from '../support/harness';

const { GatewayIdentityGuard, ServiceIdentityGuard, AllExceptionsFilter } =
  resolveGuardsAndFilter();
const APP_CONFIG = getAppConfigToken();
const { requestIdMiddleware } = getRequestId();
// The real /internal/ping scaffold controller — used to prove a mixed-case prefix
// (/INTERNAL/ping) still fails closed. It has no defensive check of its own, so a
// guard bypass would surface as a 200 rather than being masked.
const InternalController = getInternalProbeController();

// The exact machine-readable codes the real filter emits (src/common/errors/
// error-response.ts: codeForStatus) — asserted to lock the vocabulary, not guessed.
const CODE = { UNAUTHORIZED: 'UNAUTHORIZED', FORBIDDEN: 'FORBIDDEN', NOT_FOUND: 'NOT_FOUND' };

const SERVICE_TOKEN = 'super-secret-service-token';

@Controller('admin')
class AdminProbeController {
  @Get('probe')
  probe(@Req() req: any) {
    // Echo what the GUARD resolved onto the request (not the raw header), so the
    // test proves the guard parsed + attached the trusted identity.
    return { identity: req.identity ?? null };
  }

  @Get('boom')
  boom(): never {
    throw new NotFoundException('resource not found');
  }
}

@Controller('internal')
class InternalProbeController {
  @Get('probe')
  probe() {
    return { ok: true };
  }
}

// Test-only controller (test code, not production): throws a NON-HttpException whose
// message embeds a secret-looking Mongo DSN, to prove the 5xx genericization path.
const SENSITIVE_LEAK = 'sensitive: mongodb://analytics_app:s3cr3t@mongo:27017/analytics';

@Controller('leak-probe')
class LeakProbeController {
  @Get('explode')
  explode(): never {
    throw new Error(SENSITIVE_LEAK);
  }
}

function expectErrorDto(body: any, expectedCode?: string) {
  expect(body).toBeDefined();
  expect(body.error).toBeDefined();
  expect(typeof body.error.code).toBe('string');
  expect(body.error.code.length).toBeGreaterThan(0);
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(typeof body.error.requestId).toBe('string');
  expect(body.error.requestId.length).toBeGreaterThan(0);
  if (expectedCode !== undefined) {
    expect(body.error.code).toBe(expectedCode);
  }
}

describe('identity guards + error model (minimal app, no Docker)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AdminProbeController, InternalProbeController, InternalController],
      providers: [
        // Bound globally, exactly like AppModule — the guards self-scope by prefix.
        { provide: APP_GUARD, useClass: GatewayIdentityGuard },
        { provide: APP_GUARD, useClass: ServiceIdentityGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        // The service guard reads the expected token from APP_CONFIG.
        { provide: APP_CONFIG, useValue: { internalServiceToken: SERVICE_TOKEN } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(requestIdMiddleware); // correlation id, like main.ts
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  describe('gateway identity guard (/admin)', () => {
    it('rejects with 401 when the gateway header X-User-Id is absent', async () => {
      const res = await request(app.getHttpServer()).get('/admin/probe');
      expect(res.status).toBe(401);
    });

    it('rejects with 403 (FORBIDDEN) when the identity lacks the admin role', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/probe')
        .set('X-User-Id', 'user-bob')
        .set('X-Roles', 'customer');
      expect(res.status).toBe(403);
      expectErrorDto(res.body, CODE.FORBIDDEN);
    });

    it('allows an admin and resolves the identity to the HEADER value, parsing X-Roles into an array', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/probe')
        .set('X-User-Id', 'user-alice')
        .set('X-Roles', 'customer,admin');

      expect(res.status).toBe(200);
      expect(res.body.identity).toBeTruthy();
      expect(res.body.identity.userId).toBe('user-alice');
      expect(Array.isArray(res.body.identity.roles)).toBe(true);
      expect(res.body.identity.roles).toEqual(['customer', 'admin']);
    });

    it('does NOT trust a userId from query or body (no header => still 401)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/probe?userId=user-mallory')
        .send({ userId: 'user-mallory' });
      expect(res.status).toBe(401);
    });

    it('uses the HEADER identity, never a conflicting query/body id (BOLA guard)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/probe?userId=user-mallory')
        .set('X-User-Id', 'user-alice')
        .set('X-Roles', 'admin')
        .send({ userId: 'user-mallory' });

      expect(res.status).toBe(200);
      expect(res.body.identity.userId).toBe('user-alice'); // header wins, never the query/body
    });
  });

  describe('service identity guard (/internal)', () => {
    it('rejects with 401 when X-Service-Token is absent', async () => {
      const res = await request(app.getHttpServer()).get('/internal/probe');
      expect(res.status).toBe(401);
    });

    it('rejects with 401 when X-Service-Token is wrong', async () => {
      const res = await request(app.getHttpServer())
        .get('/internal/probe')
        .set('X-Service-Token', 'the-wrong-token');
      expect(res.status).toBe(401);
    });

    it('does NOT accept a user identity header in place of the service token', async () => {
      const res = await request(app.getHttpServer())
        .get('/internal/probe')
        .set('X-User-Id', 'user-alice')
        .set('X-Roles', 'admin');
      expect(res.status).toBe(401);
    });

    it('accepts when X-Service-Token matches INTERNAL_SERVICE_TOKEN', async () => {
      const res = await request(app.getHttpServer())
        .get('/internal/probe')
        .set('X-Service-Token', SERVICE_TOKEN);
      expect(res.status).toBe(200);
    });
  });

  describe('guards self-scope by prefix (global, but per-plane)', () => {
    it('the service-token guard does NOT gate /admin (a valid admin reaches /admin with no service token)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/probe')
        .set('X-User-Id', 'user-alice')
        .set('X-Roles', 'admin');
      expect(res.status).toBe(200);
    });

    it('the gateway identity guard does NOT gate /internal (a valid service peer reaches /internal with no user header)', async () => {
      const res = await request(app.getHttpServer())
        .get('/internal/probe')
        .set('X-Service-Token', SERVICE_TOKEN);
      expect(res.status).toBe(200);
    });
  });

  describe('guards fail CLOSED on mixed-case prefixes (regression: case-bypass)', () => {
    // Express routes case-insensitively, so /ADMIN and /INTERNAL reach the same
    // handlers as their lowercase forms. The guards MUST normalize the prefix and
    // still demand the credential — a case-sensitive prefix check would let a caller
    // skip auth simply by upper-casing the path.
    it('GET /INTERNAL/ping with no X-Service-Token still requires it (401, not 200)', async () => {
      const res = await request(app.getHttpServer()).get('/INTERNAL/ping');
      expect(res.status).toBe(401);
      expectErrorDto(res.body, CODE.UNAUTHORIZED);
    });

    it('GET /ADMIN/probe with a non-admin role still requires admin (403, not 200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/ADMIN/probe')
        .set('X-User-Id', 'user-bob')
        .set('X-Roles', 'customer');
      expect(res.status).toBe(403);
    });

    it('GET /ADMIN/probe with no identity at all still fails closed (401, not 200)', async () => {
      const res = await request(app.getHttpServer()).get('/ADMIN/probe');
      expect(res.status).toBe(401);
    });
  });

  describe('error model DTO + correlation id', () => {
    it('shapes a guard rejection (401) into the error DTO with code UNAUTHORIZED', async () => {
      const res = await request(app.getHttpServer()).get('/internal/probe');
      expect(res.status).toBe(401);
      expectErrorDto(res.body, CODE.UNAUTHORIZED);
    });

    it('shapes a thrown domain error (404) into the error DTO with code NOT_FOUND, status preserved', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/boom')
        .set('X-User-Id', 'user-alice')
        .set('X-Roles', 'admin');
      expect(res.status).toBe(404);
      expectErrorDto(res.body, CODE.NOT_FOUND);
    });

    it('threads an inbound X-Request-Id through the error DTO and echoes it on the response', async () => {
      const correlation = 'corr-abc-123';
      const res = await request(app.getHttpServer())
        .get('/admin/probe')
        .set('X-Request-Id', correlation);
      expect(res.status).toBe(401);
      expect(res.body.error.requestId).toBe(correlation);
      expect(res.headers['x-request-id']).toBe(correlation);
    });

    it('mints a correlation id when none is supplied, consistent request->filter->response', async () => {
      const res = await request(app.getHttpServer()).get('/internal/probe');
      expect(res.status).toBe(401);
      expect(res.body.error.requestId.length).toBeGreaterThan(0);
      expect(res.body.error.requestId).not.toBe('unknown');
      expect(res.headers['x-request-id']).toBe(res.body.error.requestId);
    });
  });
});

describe('error filter genericizes 5xx failures (no info leak)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LeakProbeController],
      // Bind the REAL exception filter globally, exactly as AppModule does.
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(requestIdMiddleware);
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('maps an unexpected Error to a generic 500 and leaks neither the cause nor a stack', async () => {
    const res = await request(app.getHttpServer()).get('/leak-probe/explode');

    expect(res.status).toBe(500);
    // Generic values from src/common/errors/{all-exceptions.filter,error-response}.ts.
    expect(res.body.error.message).toBe('Internal server error');
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expectErrorDto(res.body, 'INTERNAL_ERROR');

    // The sensitive cause and any stack frame must appear NOWHERE in the response.
    const serialized = res.text + JSON.stringify(res.body);
    expect(serialized).not.toContain('sensitive:');
    expect(serialized).not.toContain('mongodb://analytics_app:s3cr3t@mongo');
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toMatch(/\bat\s+.+:\d+:\d+/); // no stack frames
  });
});
