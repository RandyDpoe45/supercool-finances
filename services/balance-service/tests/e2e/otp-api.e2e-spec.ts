/**
 * Regression: `POST /api/otp` — the HTTP status contract of `OtpApiController.generate`.
 *
 * Contract (from the spec's OTP module + the cross-surface wire contract): minting the caller's
 * user-scoped one-time code is an ACTION on the caller's own identity, not the creation of a
 * resource at a new URL, so it answers **HTTP 200** — consistent with every sibling action-POST
 * (`@HttpCode(HttpStatus.OK)`), the otp-app MSW stub, and the client/otp e2e fixtures (all 200).
 * A bare `@Post` defaults to **201**; this suite FAILS on 201 and PASSES on 200, so it catches a
 * dropped `@HttpCode(HttpStatus.OK)` decorator.
 *
 * This is a CONTROLLER-level HTTP test, NOT a DB-backed one: the only thing under test is the
 * controller's wire contract (status + serialized body + header-scoping), so the `OTP_SERVICE`
 * (the `IOtpService` the controller injects) is MOCKED — no Redis, no Postgres, no Docker. The
 * REAL `GatewayIdentityGuard` is bound globally (APP_GUARD, exactly as AppModule does) so the
 * `@Identity()` the handler reads is the true Kong-header-derived identity, not a hand-set stub.
 * Runs under the default e2e runner (`npm run test:e2e`).
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { OtpApiController } from '../../src/modules/otp/api/otp-api.controller';
import { OTP_SERVICE } from '../../src/modules/otp/service/interfaces/otp.service.interface';
import { resolveGuardsAndFilter } from '../support/harness';

// The implementor's REAL gateway guard (single-seam import), bound globally like AppModule so
// `@Identity()` resolves the header-derived identity the handler passes to the service.
const { GatewayIdentityGuard } = resolveGuardsAndFilter();

describe('OtpApiController — POST /api/otp HTTP contract (mocked service, no DB)', () => {
  let app: INestApplication;

  // The controller injects IOtpService behind OTP_SERVICE; only `generate` is exercised here.
  // `consume` is present so the double satisfies the interface shape.
  const generate = jest.fn();
  const consume = jest.fn();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [OtpApiController],
      providers: [
        { provide: OTP_SERVICE, useValue: { generate, consume } },
        // Global, exactly like AppModule — so the handler's @Identity() is the real guard's
        // header-parsed identity (and a missing X-User-Id is a real 401, not a crash).
        { provide: APP_GUARD, useClass: GatewayIdentityGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  // ---- KEYSTONE: the status is exactly 200, never 201 --------------------------------------

  it('answers 200 (NOT 201) and returns the serialized { code, ttlSeconds }', async () => {
    generate.mockResolvedValue({ code: '123456', ttlSeconds: 300 });

    const res = await request(app.getHttpServer())
      .post('/api/otp')
      .set('X-User-Id', 'user-alice')
      .set('X-Roles', 'customer')
      .send({});

    // The bug being fixed: a bare @Post answers 201. Pin it to 200 so a regression fails here.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: '123456', ttlSeconds: 300 });
  });

  // ---- the mint is scoped to the gateway identity, never a body/query userId ----------------

  it('scopes the mint to the X-User-Id identity, never a conflicting body/query userId (BOLA)', async () => {
    generate.mockResolvedValue({ code: '000000', ttlSeconds: 300 });

    const res = await request(app.getHttpServer())
      .post('/api/otp?userId=user-mallory')
      .set('X-User-Id', 'user-alice')
      .set('X-Roles', 'customer')
      .send({ userId: 'user-mallory' });

    expect(res.status).toBe(200);
    // The controller must mint for the header identity — NOT the attacker-supplied body/query id.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith('user-alice');
  });

  // ---- explicit-whitelist serializer: an internal field never reaches the wire --------------

  it('serializes via the explicit whitelist — an extra service-side field never leaks to the body', async () => {
    // The service result may carry internal fields (e.g. an at-rest codeHash). serializeOtp must
    // whitelist to exactly {code, ttlSeconds}; a raw spread would leak `codeHash`.
    generate.mockResolvedValue({
      code: '654321',
      ttlSeconds: 120,
      codeHash: 'INTERNAL-AT-REST-HASH',
    } as never);

    const res = await request(app.getHttpServer())
      .post('/api/otp')
      .set('X-User-Id', 'user-bob')
      .set('X-Roles', 'customer')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ code: '654321', ttlSeconds: 120 });
    expect(res.body.codeHash).toBeUndefined();
    expect(Object.keys(res.body).sort()).toEqual(['code', 'ttlSeconds']);
  });

  // ---- the gateway guard still gates this POST (no header => 401, service never called) ------

  it('rejects with 401 when the gateway X-User-Id header is absent (service not invoked)', async () => {
    const res = await request(app.getHttpServer()).post('/api/otp').send({});

    expect(res.status).toBe(401);
    expect(generate).not.toHaveBeenCalled();
  });
});
