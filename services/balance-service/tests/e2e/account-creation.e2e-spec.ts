/**
 * Spec 04 — Balance Service: customer self-service account creation (`POST /api/accounts`) — the
 * HTTP surface end-to-end over supertest, booting the REAL AppModule (global gateway identity guard
 * + the exception filter + zod request validation). Written FROM the developer-locked HTTP contract,
 * NOT the impl.
 *
 * This suite owns the WIRE CONTRACT (the DB-observable money-safety + the concurrency cap proof live
 * in the integration suite):
 *   - 201 + the AccountDto whitelist over the wire: EXACTLY { id, currency, status, kind, balance,
 *     held, available, accountNumber, label }, with balance/held/available all "0" (a self-service
 *     create never seeds funds), currency MXN / status active / kind customer, a 10-digit
 *     accountNumber, and the TRIMMED label; no owner sub leak.
 *   - the validation table → 400 BAD_REQUEST (ErrorResponse shape): missing label, empty/whitespace,
 *     >50 chars, non-string, a control character, and an unknown extra key (`.strict()`).
 *   - the per-customer cap (5): the 6th create → 422 ACCOUNT_LIMIT_REACHED with the standard
 *     ErrorResponse body { error: { code, message, requestId } }.
 *   - the owner is taken from X-User-Id, never the body: two different identities get two different
 *     owners, and a body carrying `ownerId` is rejected (400).
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (the write path hits Postgres). beforeAll TCP-probes
 * Postgres and fails loud if unreachable; boots AppModule (migrationsRun:true). Unique owners per
 * test; committed rows cleaned up per-test.
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
import { insertCustomer } from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[e2e] SKIPPED account-creation HTTP suite: set BALANCE_INTEGRATION=1 (and point DB_* at Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

const suite = ENABLED ? describe : describe.skip;

/** Exactly the whitelisted keys the account DTO must carry over the wire. */
const ACCOUNT_DTO_KEYS = [
  'id',
  'currency',
  'status',
  'kind',
  'balance',
  'held',
  'available',
  'accountNumber',
  'label',
];

const MAX_CUSTOMER_ACCOUNTS = 5;

suite(
  'POST /api/accounts — HTTP contract: 201 DTO, validation, cap, identity (e2e, needs Postgres)',
  () => {
    let app: INestApplication;
    let ds: any;
    let http: any;

    const seededOwners = new Set<string>();

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
    }, 60_000);

    afterEach(async () => {
      const owners = Array.from(seededOwners);
      seededOwners.clear();
      if (!owners.length) return;
      try {
        await ds.query(`DELETE FROM "audit_log" WHERE "actor_id" = ANY($1)`, [owners]);
      } catch {
        /* best-effort */
      }
      try {
        await ds.query(`DELETE FROM "account" WHERE "owner_id" = ANY($1)`, [owners]);
      } catch {
        /* best-effort */
      }
      try {
        await ds.query(`DELETE FROM "customer" WHERE "id" = ANY($1)`, [owners]);
      } catch {
        /* best-effort */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- helpers -------------------------------------------------------------------------------

    async function newOwner(): Promise<string> {
      const owner = `sub-${randomUUID()}`;
      await insertCustomer(ds, owner);
      seededOwners.add(owner);
      return owner;
    }

    const createFor = (owner: string, body: unknown) =>
      request(http)
        .post('/api/accounts')
        .set('X-User-Id', owner)
        .set('X-Roles', 'customer')
        .send(body as object);

    function expectErrorDto(body: any, code?: string): void {
      expect(body).toBeDefined();
      expect(body.error).toBeDefined();
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.message.length).toBeGreaterThan(0);
      // The correlation id threads through every error (see request-id middleware).
      expect(typeof body.error.requestId).toBe('string');
      expect(body.error.requestId.length).toBeGreaterThan(0);
      if (code !== undefined) expect(body.error.code).toBe(code);
    }

    // ---- 201 + AccountDto whitelist over the wire --------------------------------------------

    it('POST /api/accounts { label } → 201 with EXACTLY the AccountDto whitelist, money all "0", trimmed label', async () => {
      const owner = await newOwner();

      const res = await createFor(owner, { label: '  Emergency Fund  ' });
      expect(res.status).toBe(201);

      const dto = res.body;
      expect(Object.keys(dto).sort()).toEqual([...ACCOUNT_DTO_KEYS].sort());
      expect(typeof dto.id).toBe('string');
      expect(dto.currency).toBe('MXN');
      expect(dto.status).toBe('active');
      expect(dto.kind).toBe('customer');
      // MONEY-SAFETY over the wire: the mint carries no funds.
      expect(dto.balance).toBe('0');
      expect(dto.held).toBe('0');
      expect(dto.available).toBe('0');
      expect(dto.accountNumber).toMatch(/^\d{10}$/);
      expect(dto.label).toBe('Emergency Fund'); // trimmed

      // Anti-leak: no owner sub in the response body.
      expect(JSON.stringify(dto)).not.toContain(owner);
    });

    // ---- validation table → 400 BAD_REQUEST ---------------------------------------------------

    it('rejects invalid bodies with 400 BAD_REQUEST (missing, empty, whitespace, >50, non-string, control char, extra key)', async () => {
      const owner = await newOwner();

      const cases: unknown[] = [
        {}, // missing label
        { label: '' }, // empty
        { label: '   ' }, // whitespace-only
        { label: 'a'.repeat(51) }, // > 50 after trim
        { label: 123 }, // non-string
        { label: 'bad\nlabel' }, // control character
        { label: 'ok', surprise: true }, // unknown extra key (.strict())
      ];

      for (const body of cases) {
        const res = await createFor(owner, body);
        expect(res.status).toBe(400);
        expectErrorDto(res.body, 'BAD_REQUEST');
      }
    });

    // ---- per-customer cap (5) → 422 ACCOUNT_LIMIT_REACHED -------------------------------------

    it('the 6th create → 422 ACCOUNT_LIMIT_REACHED with the standard ErrorResponse body', async () => {
      const owner = await newOwner();

      for (let i = 0; i < MAX_CUSTOMER_ACCOUNTS; i += 1) {
        const ok = await createFor(owner, { label: `acct-${i}` });
        expect(ok.status).toBe(201);
      }

      const overCap = await createFor(owner, { label: 'one-too-many' });
      expect(overCap.status).toBe(422);
      expectErrorDto(overCap.body, 'ACCOUNT_LIMIT_REACHED');
    });

    // ---- owner comes from X-User-Id, never the body ------------------------------------------

    it('the owner is the X-User-Id identity: two identities get two independent owners', async () => {
      const ownerA = await newOwner();
      const ownerB = await newOwner();

      const a = await createFor(ownerA, { label: 'A' });
      const b = await createFor(ownerB, { label: 'B' });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      const listA = await request(http)
        .get('/api/accounts')
        .set('X-User-Id', ownerA)
        .set('X-Roles', 'customer');
      const idsA = listA.body.accounts.map((acc: any) => acc.id);
      expect(idsA).toContain(a.body.id);
      expect(idsA).not.toContain(b.body.id); // B's account is never A's
    });

    it('a body smuggling ownerId is rejected (400) — the caller can NEVER choose the owner', async () => {
      const owner = await newOwner();
      const attacker = `sub-${randomUUID()}`;

      const res = await createFor(owner, { label: 'ok', ownerId: attacker });
      expect(res.status).toBe(400);
      expectErrorDto(res.body, 'BAD_REQUEST');
    });
  },
);
