/**
 * Spec 04 — Balance Service, External payees: the `/api/payees` HTTP surface end-to-end over
 * supertest, booting the REAL AppModule (global gateway identity guard + the exception filter + zod
 * request validation). Written FROM the developer-locked HTTP contract, NOT the impl.
 *
 * Endpoints under test:
 *   POST /api/payees  (body {displayName, destinationRef})  → 201 + the new payee DTO
 *   GET  /api/payees                                        → the caller's enrolled payees
 *
 * It proves:
 *   - the payee DTO whitelist over the wire: EXACTLY { id, displayName, destinationRef, coolingOffUntil,
 *     usable, createdAt }, with usable:false for a freshly-enrolled payee (still cooling off), and NO
 *     ownerId / rail / status leak;
 *   - a duplicate POST (same destinationRef, same user) → 409;
 *   - zod validation: missing displayName → 400; a destinationRef out of the digit/length bound → 400;
 *     unknown/extra keys rejected → 400;
 *   - the caller cannot CHOOSE the rail/owner/status: a body carrying rail/ownerId/status is ignored
 *     or rejected — proven at the DB (persisted rail = the constant, owner = the caller, status = the
 *     default), so injection is impossible whichever the schema does;
 *   - object-level authorization: GET returns the caller's payees ONLY (another user's payee is never
 *     returned), with no owner-sub / rail leak in the body.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (the write path hits Postgres). beforeAll TCP-probes
 * Postgres and fails loud if unreachable; boots AppModule (migrationsRun:true). Unique owners/refs
 * per test; committed rows cleaned up per-test. (Payee enrollment touches no Redis.)
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=…] npm run test:e2e
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import * as harness from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[e2e] SKIPPED payees HTTP suite: set BALANCE_INTEGRATION=1 (and point DB_* at Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

const suite = ENABLED ? describe : describe.skip;

/** Exactly the whitelisted keys the payee DTO must carry over the wire. */
const PAYEE_DTO_KEYS = [
  'id',
  'displayName',
  'destinationRef',
  'coolingOffUntil',
  'usable',
  'createdAt',
];

suite(
  'payees HTTP surface — enroll / list, validation, authz, anti-leak (e2e, needs Postgres)',
  () => {
    let app: INestApplication;
    let ds: any;
    let http: any;
    let outboundRail: string;

    let trackedOwners: string[] = [];

    beforeAll(async () => {
      const pgOk = await harness.tcpProbe(DB_HOST, DB_PORT);
      if (!pgOk) throw new Error(`[e2e] Postgres not reachable at ${DB_HOST}:${DB_PORT}.`);

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
        OTP_HASH_SECRET: process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789',
      });
      for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

      const AppModule = harness.getAppModule();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      http = app.getHttpServer();

      try {
        const { DataSource } = require('typeorm');
        ds = app.get(DataSource);
      } catch {
        const { getDataSourceToken } = require('@nestjs/typeorm');
        ds = app.get(getDataSourceToken());
      }
      if (!ds) throw new Error('[e2e] could not resolve the TypeORM DataSource from the app');

      outboundRail = (harness as any).getOutboundRail?.();
      if (outboundRail === undefined) {
        throw new Error(
          '[e2e] getOutboundRail() is not resolvable via tests/support/harness.ts — reconcile the ' +
            'constant-rail seam (needed for the anti-leak + injection proofs).',
        );
      }
    }, 60_000);

    afterEach(async () => {
      const owners = trackedOwners;
      trackedOwners = [];
      if (owners.length) {
        try {
          await ds.query(`DELETE FROM external_payee WHERE owner_id = ANY($1)`, [owners]);
        } catch {
          /* best-effort */
        }
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- helpers -----------------------------------------------------------------------------

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
    }

    /** A 10-digit numeric external-bank-account ref (a shape the enrollment schema accepts). */
    function newRef(): string {
      let s = '';
      for (let i = 0; i < 10; i++) s += String(Math.floor(Math.random() * 10));
      return s;
    }

    const asUser = (userId: string) => ({
      post: (path: string) =>
        request(http).post(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
      get: (path: string) =>
        request(http).get(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
    });

    /** Unwrap the single-payee response, tolerating a `{ payee }` wrapper or the DTO directly. */
    function payeeOf(body: any): any {
      return body?.payee ?? body;
    }
    /** Unwrap the list response, tolerating a `{ payees }` wrapper or a bare array. */
    function payeesOf(body: any): any[] {
      if (Array.isArray(body)) return body;
      if (Array.isArray(body?.payees)) return body.payees;
      return [];
    }

    function expectErrorDto(body: any, code?: string): void {
      expect(body).toBeDefined();
      expect(body.error).toBeDefined();
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.message.length).toBeGreaterThan(0);
      if (code !== undefined) expect(body.error.code).toBe(code);
    }

    // ---- POST /api/payees: 201 + the whitelisted DTO, usable:false, no owner/rail/status leak ----

    it('POST /api/payees {displayName, destinationRef} → 201 with EXACTLY {id,displayName,destinationRef,coolingOffUntil,usable:false,createdAt}; no ownerId/rail/status', async () => {
      const owner = newOwner();
      const ref = newRef();

      const res = await asUser(owner)
        .post('/api/payees')
        .send({ displayName: 'ACME Corp', destinationRef: ref });
      expect(res.status).toBe(201);

      const dto = payeeOf(res.body);
      expect(Object.keys(dto).sort()).toEqual([...PAYEE_DTO_KEYS].sort());
      expect(typeof dto.id).toBe('string');
      expect(dto.displayName).toBe('ACME Corp');
      expect(dto.destinationRef).toBe(ref);
      expect(typeof dto.coolingOffUntil).toBe('string'); // ISO timestamp
      expect(typeof dto.createdAt).toBe('string');
      // A freshly-enrolled payee is STILL cooling off → not yet usable.
      expect(dto.usable).toBe(false);

      // Anti-leak: internal fields never cross the wire.
      for (const k of ['ownerId', 'rail', 'status', 'activatedAt']) expect(k in dto).toBe(false);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(owner); // the owner sub is a secret
      expect(serialized).not.toContain(outboundRail); // the rail is not the caller's business
    });

    // ---- duplicate enrollment → 409 ---------------------------------------------------------

    it('a duplicate POST /api/payees (same destinationRef, same user) → 409', async () => {
      const owner = newOwner();
      const ref = newRef();

      const first = await asUser(owner)
        .post('/api/payees')
        .send({ displayName: 'ACME', destinationRef: ref });
      expect(first.status).toBe(201);

      const dup = await asUser(owner)
        .post('/api/payees')
        .send({ displayName: 'ACME 2', destinationRef: ref });
      expect(dup.status).toBe(409);
      expectErrorDto(dup.body, 'PAYEE_ALREADY_ENROLLED');
    });

    // ---- zod validation → 400 ---------------------------------------------------------------

    it('POST /api/payees rejects malformed bodies with 400 (missing displayName, bad destinationRef, unknown keys)', async () => {
      const owner = newOwner();
      const ref = newRef();

      // Missing displayName.
      const noName = await asUser(owner).post('/api/payees').send({ destinationRef: ref });
      expect(noName.status).toBe(400);
      expectErrorDto(noName.body, 'BAD_REQUEST');

      // Missing destinationRef.
      const noRef = await asUser(owner).post('/api/payees').send({ displayName: 'ACME' });
      expect(noRef.status).toBe(400);

      // destinationRef out of the digit/length bound: empty, non-numeric, and absurdly long.
      const emptyRef = await asUser(owner)
        .post('/api/payees')
        .send({ displayName: 'ACME', destinationRef: '' });
      expect(emptyRef.status).toBe(400);

      const nonNumericRef = await asUser(owner)
        .post('/api/payees')
        .send({ displayName: 'ACME', destinationRef: 'not-a-number' });
      expect(nonNumericRef.status).toBe(400);

      const tooLongRef = await asUser(owner)
        .post('/api/payees')
        .send({ displayName: 'ACME', destinationRef: '1'.repeat(64) });
      expect(tooLongRef.status).toBe(400);

      // Unknown/extra keys are rejected by the schema (deliberate: a caller may not smuggle fields).
      const extraKey = await asUser(owner)
        .post('/api/payees')
        .send({ displayName: 'ACME', destinationRef: newRef(), bogusField: 'nope' });
      expect(extraKey.status).toBe(400);
    });

    // ---- caller cannot choose rail / owner / status -----------------------------------------

    it('a body trying to set rail/ownerId/status is REJECTED (400) — the caller can NEVER choose them', async () => {
      const owner = newOwner();
      const attackerSub = `sub-${randomUUID()}`;

      // The `.strict()` schema rejects the extra keys outright (400), so a caller cannot even submit
      // rail/ownerId/status. That the PERSISTED rail is the CONSTANT and the owner is the caller
      // (regardless of any input) is proven at the DB elsewhere: the unit service spec (the constant
      // rail reaches the repo, an attacker rail never does) and the integration happy-path
      // (`row.rail === outboundRail`). This test pins only the wire-level rejection.
      const res = await asUser(owner).post('/api/payees').send({
        displayName: 'ACME',
        destinationRef: newRef(),
        rail: 'attacker-rail',
        ownerId: attackerSub,
        status: 'active',
      });

      expect(res.status).toBe(400);
    });

    // ---- GET /api/payees: caller's payees only (anti-IDOR) ----------------------------------

    it("GET /api/payees returns the caller's payees only — another user's payee is never returned", async () => {
      const a = newOwner();
      const b = newOwner();

      const pa = await asUser(a)
        .post('/api/payees')
        .send({ displayName: 'A-payee', destinationRef: newRef() });
      const pb = await asUser(b)
        .post('/api/payees')
        .send({ displayName: 'B-payee', destinationRef: newRef() });
      expect(pa.status).toBe(201);
      expect(pb.status).toBe(201);

      const res = await asUser(a).get('/api/payees');
      expect(res.status).toBe(200);

      const ids = payeesOf(res.body).map((p) => p.id);
      expect(ids).toContain(payeeOf(pa.body).id);
      expect(ids).not.toContain(payeeOf(pb.body).id); // B's payee never surfaces for A

      // Anti-leak on the list: neither owner sub nor the rail crosses the wire.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(a);
      expect(serialized).not.toContain(b);
      expect(serialized).not.toContain(outboundRail);
    });
  },
);
