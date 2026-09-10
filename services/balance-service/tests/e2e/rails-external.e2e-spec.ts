/**
 * Spec 04 — Balance Service, step 5c: the `/external` RAIL-WEBHOOK HTTP surface end-to-end over
 * supertest, booting the REAL AppModule (the global `ExternalApiKeyGuard` scoped to the `external`
 * prefix + the exception filter + zod request validation). Written FROM the developer-locked HTTP
 * contract (spec 04 "Mocked external rails" + the `/external` endpoints line), NOT the impl.
 *
 * Endpoints under test:
 *   POST /external/rails/settlement-callback { transactionId, status, externalRef }  (X-Api-Key)
 *       → 200 ack; SUCCESS reconciles (records externalRef, NO new ledger); FAILURE reverses
 *         (clearing → customer refund).
 *   POST /external/rails/inbound { accountNumber, amount, currency, externalRef }    (X-Api-Key)
 *       → 200 ack; credits the customer by account number; idempotent by externalRef.
 *
 * It proves at the HTTP edge:
 *   - AUTH is a DISTINCT trust domain: a missing / wrong `X-Api-Key` → 401 and NO state change; the
 *     `/internal` `X-Service-Token` does NOT authenticate `/external`; a valid key runs the handler.
 *   - zod-invalid bodies → 400.
 *   - SUCCESS reconcile → 200 with NO new ledger (verified at the DB); FAILURE reversal → 200 with
 *     the payer refunded (verified at the DB); INBOUND credit → 200 with the customer credited
 *     (verified at the DB); a DUPLICATE inbound ref → still exactly one credit.
 *   - the ack DTO leaks no internal fields (owner sub, account UUID/number, balances).
 *   - a FULL SLICE: 5b external initiate → OTP-confirm (settle to clearing) → 5c SUCCESS callback
 *     reconciles WITHOUT moving money again; and a FAILURE variant refunds the payer.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (Postgres AND Redis). beforeAll TCP-probes both and
 * fails loud if unreachable; boots AppModule (migrationsRun:true). Unique owners/accounts per test;
 * committed rows + minted OTP keys cleaned up per-test.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm run test:e2e
 */
import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { getAppModule, getRedisClientToken, getOutboundRail, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import {
  insertAccount,
  insertTransaction,
  insertHold,
  insertLedgerEntry,
  insertExternalPayee,
  localAccountNumber,
} from '../support/pg';
import * as pg from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[e2e] SKIPPED external-rail webhooks HTTP suite: set BALANCE_INTEGRATION=1 (and point DB_* at ' +
      'Postgres AND REDIS_* at Redis) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-service-token';
// The external rail webhook API key — set into the env this suite boots with, so the guard compares
// against a value THIS test controls and uses as `X-Api-Key`.
const RAILS_WEBHOOK_API_KEY = process.env.RAILS_WEBHOOK_API_KEY || 'test-rails-webhook-api-key';
const MXN = 'MXN';

// Settlement `status` literal — DEVELOPER-LOCKED to lowercase `'success'` / `'failure'` (the wire
// schema is `z.enum(['success','failure'])`, so an uppercase body would 400); ambiguity resolved.
const STATUS_SUCCESS = 'success';
const STATUS_FAILURE = 'failure';

const suite = ENABLED ? describe : describe.skip;

suite(
  'external-rail webhooks HTTP surface (step 5c) — X-Api-Key auth, reconcile/reverse/inbound, anti-leak (e2e, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let redis: any;
    let http: any;
    let outboundClearingId: string;
    let inboundClearingId: string;

    let createdAccountIds: string[] = [];
    let trackedOwners: string[] = [];
    let trackedRedisKeys: string[] = [];

    beforeAll(async () => {
      const [pgOk, redisOk] = await Promise.all([
        tcpProbe(DB_HOST, DB_PORT),
        tcpProbe(REDIS_HOST, REDIS_PORT),
      ]);
      if (!pgOk) throw new Error(`[e2e] Postgres not reachable at ${DB_HOST}:${DB_PORT}.`);
      if (!redisOk) throw new Error(`[e2e] Redis not reachable at ${REDIS_HOST}:${REDIS_PORT}.`);

      const env = completeRawEnv({
        DB_HOST,
        DB_PORT: String(DB_PORT),
        DB_NAME: process.env.DB_NAME || 'balance',
        DB_USER: process.env.DB_USER || 'balance_app',
        DB_PASSWORD: process.env.DB_PASSWORD || 'changeme-balance-local',
        REDIS_HOST,
        REDIS_PORT: String(REDIS_PORT),
        REDIS_PASSWORD: process.env.REDIS_PASSWORD || 'changeme-redis-local',
        INTERNAL_SERVICE_TOKEN,
        OTP_HASH_SECRET,
        RAILS_WEBHOOK_API_KEY,
      });
      for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

      const AppModule = getAppModule();
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

      redis = app.get(getRedisClientToken(), { strict: false });

      outboundClearingId = await systemAccountId('clearing:rail-outbound');
      inboundClearingId = await systemAccountId('clearing:rail-inbound');

      for (const fn of ['findLedgerByTx', 'outboxCountForTx']) {
        if (typeof (pg as any)[fn] !== 'function') {
          throw new Error(
            `[e2e] pg.${fn} is not available in tests/support/pg.ts (FIXED step-5c support contract). ` +
              `Reconcile the contract before running the gate.`,
          );
        }
      }
    }, 60_000);

    afterEach(async () => {
      const ids = createdAccountIds;
      const owners = trackedOwners;
      const redisKeys = Array.from(new Set(trackedRedisKeys));
      createdAccountIds = [];
      trackedOwners = [];
      trackedRedisKeys = [];
      if (redis && redisKeys.length) {
        try {
          await redis.del(...redisKeys);
        } catch {
          /* best-effort */
        }
      }
      try {
        await cleanup(ids, owners);
      } catch {
        /* best-effort */
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- helpers ------------------------------------------------------------------------------

    async function systemAccountId(systemKey: string): Promise<string> {
      const r = await ds.query(`SELECT id FROM account WHERE kind = 'system' AND system_key = $1`, [
        systemKey,
      ]);
      if (!r[0]?.id) throw new Error(`[e2e] system account ${systemKey} is not seeded.`);
      return r[0].id;
    }

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
    }

    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      const acc = await insertAccount(ds, {
        kind: 'customer',
        owner_id: owner,
        currency: MXN,
        status: 'active',
        balance: 0,
        held: 0,
        account_number: localAccountNumber(),
        ...overrides,
      });
      createdAccountIds.push(acc.id);
      return acc;
    }

    async function mkPayee(owner: string, opts: { coolingOffUntil?: Date } = {}): Promise<any> {
      return insertExternalPayee(ds, {
        ownerId: owner,
        displayName: 'Acme Payments',
        rail: getOutboundRail(),
        coolingOffUntil: opts.coolingOffUntil ?? new Date(Date.now() - 60_000),
      });
    }

    /** Seed the state a 5b OTP-confirm leaves: POSTED external_outbound, SETTLED hold (ref null), the
     *  two original legs, customer already debited by `amount`. */
    async function seedSettledOutbound(
      owner: string,
      amount: number,
      startingBalance = 10000,
    ): Promise<{ src: any; tx: any }> {
      const debited = startingBalance - amount;
      const src = await mkCustomer(owner, { balance: debited, held: 0 });
      const tx = await insertTransaction(ds, {
        type: 'external_outbound',
        status: 'POSTED',
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: outboundClearingId,
        amount: String(amount),
        currency: MXN,
        postedAt: new Date(),
      });
      await insertHold(ds, {
        accountId: src.id,
        transactionId: tx.id,
        amount,
        status: 'SETTLED',
        rail: getOutboundRail(),
        settledAt: new Date(),
      });
      const clearingNow = await accountBalance(outboundClearingId);
      await insertLedgerEntry(ds, {
        transaction_id: tx.id,
        account_id: src.id,
        delta: -amount,
        balance_after: debited,
        currency: MXN,
      });
      await insertLedgerEntry(ds, {
        transaction_id: tx.id,
        account_id: outboundClearingId,
        delta: amount,
        balance_after: String(clearingNow),
        currency: MXN,
      });
      return { src, tx };
    }

    async function cleanup(ids: string[], owners: string[]): Promise<void> {
      if (!ids.length && !owners.length) return;
      const txRows = await ds.query(
        `SELECT id FROM "transaction"
        WHERE debit_account_id = ANY($1) OR credit_account_id = ANY($1) OR initiated_by = ANY($2)
        UNION SELECT DISTINCT transaction_id AS id FROM ledger_entry WHERE account_id = ANY($1)
        UNION SELECT DISTINCT transaction_id AS id FROM hold WHERE account_id = ANY($1)`,
        [ids, owners],
      );
      const txIds = txRows.map((r: any) => r.id);
      if (txIds.length) {
        await ds.query(
          `UPDATE "transaction" SET reverses_transaction_id = NULL WHERE reverses_transaction_id = ANY($1)`,
          [txIds],
        );
        await ds.query(`DELETE FROM idempotency_key WHERE transaction_id = ANY($1)`, [txIds]);
        await ds.query(`DELETE FROM outbox_event WHERE transaction_id = ANY($1)`, [txIds]);
        await ds.query(`DELETE FROM hold WHERE transaction_id = ANY($1)`, [txIds]);
        await ds.query(`DELETE FROM ledger_entry WHERE transaction_id = ANY($1)`, [txIds]);
        await ds.query(`DELETE FROM "transaction" WHERE id = ANY($1)`, [txIds]);
      }
      if (owners.length) {
        await ds.query(`DELETE FROM idempotency_key WHERE owner_id = ANY($1)`, [owners]);
        await ds.query(`DELETE FROM external_payee WHERE owner_id = ANY($1)`, [owners]);
      }
      if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
      if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
    }

    async function accountBalance(id: string): Promise<bigint> {
      const r = await ds.query(`SELECT balance FROM account WHERE id = $1`, [id]);
      return BigInt(r[0].balance);
    }
    async function accountRow(id: string): Promise<{ balance: string; held: string }> {
      const r = await ds.query(`SELECT balance, held FROM account WHERE id = $1`, [id]);
      return r[0];
    }
    async function txStatus(id: string): Promise<string | undefined> {
      const r = await ds.query(`SELECT status FROM "transaction" WHERE id = $1`, [id]);
      return r[0]?.status;
    }
    async function holdRefForTx(id: string): Promise<string | null | undefined> {
      const r = await ds.query(`SELECT external_ref FROM hold WHERE transaction_id = $1`, [id]);
      return r[0]?.external_ref;
    }
    async function compensatingCount(origId: string): Promise<number> {
      const r = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction" WHERE reverses_transaction_id = $1`,
        [origId],
      );
      return r[0].n;
    }
    async function legsForTx(id: string): Promise<Array<{ account_id: string; delta: string }>> {
      return (pg as any).findLedgerByTx(ds, id);
    }
    async function inboundTxCount(accountId: string): Promise<number> {
      const r = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction" WHERE type = 'external_inbound' AND credit_account_id = $1`,
        [accountId],
      );
      return r[0].n;
    }

    const asExternal = (apiKey?: string) => {
      const post = (path: string) => {
        const req = request(http).post(path);
        if (apiKey !== undefined) req.set('X-Api-Key', apiKey);
        return req;
      };
      return { post };
    };

    const asUser = (userId: string) => ({
      post: (path: string) =>
        request(http).post(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
      get: (path: string) =>
        request(http).get(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
    });

    function settlementBody(
      transactionId: string,
      status: string,
      externalRef = `rail-ref-${randomUUID()}`,
    ) {
      return { transactionId, status, externalRef };
    }
    function inboundBody(
      accountNumber: string,
      amount: number,
      externalRef = `rail-ref-${randomUUID()}`,
    ) {
      return { accountNumber, amount: String(amount), currency: MXN, externalRef };
    }

    function expectErrorDto(body: any): void {
      expect(body).toBeDefined();
      expect(body.error).toBeDefined();
      expect(typeof body.error.code).toBe('string');
      expect(body.error.code.length).toBeGreaterThan(0);
      expect(typeof body.error.message).toBe('string');
    }

    async function mintOtp(owner: string): Promise<string | undefined> {
      const res = await asUser(owner).post('/api/otp').send({});
      const code = res.body?.code ?? res.body?.otp?.code;
      if (code) {
        trackedRedisKeys.push(`otp:${owner}`);
        trackedRedisKeys.push(
          `otp:${owner}:${createHmac('sha256', OTP_HASH_SECRET).update(`${owner}:${code}`).digest('hex')}`,
        );
      }
      return code;
    }
    function idOf(body: any): string {
      const t = body?.transfer ?? body?.transaction ?? body;
      return (t?.id ?? t?.transferId ?? t?.transactionId) as string;
    }

    // =========================================================================================
    // AUTH — the /external trust domain (X-Api-Key), distinct from /internal (X-Service-Token)
    // =========================================================================================

    it('settlement-callback with NO X-Api-Key → 401 and NO state change', async () => {
      const owner = newOwner();
      const { src, tx } = await seedSettledOutbound(owner, 3000);
      const before = await accountRow(src.id);

      const res = await asExternal(/* no key */)
        .post('/external/rails/settlement-callback')
        .send(settlementBody(tx.id, STATUS_FAILURE));
      expect(res.status).toBe(401);

      // The guard blocked BEFORE the handler: no refund, no reversal.
      expect((await accountRow(src.id)).balance).toBe(before.balance);
      expect(await txStatus(tx.id)).toBe('POSTED');
      expect(await compensatingCount(tx.id)).toBe(0);
    });

    it('settlement-callback with a WRONG X-Api-Key → 401 and NO state change', async () => {
      const owner = newOwner();
      const { src, tx } = await seedSettledOutbound(owner, 3000);
      const before = await accountRow(src.id);

      const res = await asExternal('not-the-key')
        .post('/external/rails/settlement-callback')
        .send(settlementBody(tx.id, STATUS_FAILURE));
      expect(res.status).toBe(401);
      expect((await accountRow(src.id)).balance).toBe(before.balance);
      expect(await compensatingCount(tx.id)).toBe(0);
    });

    it('the /internal X-Service-Token does NOT authenticate /external → 401', async () => {
      const owner = newOwner();
      const { tx } = await seedSettledOutbound(owner, 3000);

      const res = await request(http)
        .post('/external/rails/settlement-callback')
        .set('X-Service-Token', INTERNAL_SERVICE_TOKEN) // valid for /internal, NOT for /external
        .send(settlementBody(tx.id, STATUS_SUCCESS));
      expect(res.status).toBe(401);
      // And even the customer gateway header must not open /external.
      const res2 = await request(http)
        .post('/external/rails/inbound')
        .set('X-User-Id', owner)
        .set('X-Roles', 'customer')
        .send(inboundBody(localAccountNumber(), 1000));
      expect(res2.status).toBe(401);
    });

    it('inbound with a wrong / missing X-Api-Key → 401', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0 });

      const missing = await asExternal(/* none */)
        .post('/external/rails/inbound')
        .send(inboundBody(cust.account_number, 1000));
      expect(missing.status).toBe(401);

      const wrong = await asExternal('bad')
        .post('/external/rails/inbound')
        .send(inboundBody(cust.account_number, 1000));
      expect(wrong.status).toBe(401);

      expect((await accountRow(cust.id)).balance).toBe('0'); // never credited
    });

    // =========================================================================================
    // VALIDATION — a valid key, then a malformed body → 400
    // =========================================================================================

    it('malformed bodies → 400 (settlement missing transactionId; inbound missing accountNumber / non-positive amount)', async () => {
      const badSettle = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/settlement-callback')
        .send({ status: STATUS_SUCCESS, externalRef: 'r1' }); // no transactionId
      expect(badSettle.status).toBe(400);
      expectErrorDto(badSettle.body);

      const noAccount = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/inbound')
        .send({ amount: '1000', currency: MXN, externalRef: 'r2' }); // no accountNumber
      expect(noAccount.status).toBe(400);

      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0 });
      const badAmount = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/inbound')
        .send({ ...inboundBody(cust.account_number, 1000), amount: '-500' });
      expect(badAmount.status).toBe(400);
      expect((await accountRow(cust.id)).balance).toBe('0');
    });

    // =========================================================================================
    // SUCCESS reconcile / FAILURE reversal over HTTP — verified at the DB
    // =========================================================================================

    it('settlement SUCCESS → 200 ack; reconcile records the hold ref, moves NO money (verified at the DB); ack leaks no internal fields', async () => {
      const owner = newOwner();
      const AMOUNT = 4000;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT);
      const before = await accountRow(src.id);
      const externalRef = `rail-ref-${randomUUID()}`;

      const res = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/settlement-callback')
        .send(settlementBody(tx.id, STATUS_SUCCESS, externalRef));
      expect(res.status).toBe(200);

      // At the DB: the ref is stamped, the transfer stays POSTED, no reversal, balances unchanged.
      expect(await holdRefForTx(tx.id)).toBe(externalRef);
      expect(await txStatus(tx.id)).toBe('POSTED');
      expect(await compensatingCount(tx.id)).toBe(0);
      expect((await accountRow(src.id)).balance).toBe(before.balance);
      expect((await accountRow(src.id)).held).toBe(before.held);

      // The ack DTO must not leak internal state.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(owner); // owner sub
      expect(serialized).not.toContain(src.id); // customer account UUID
      expect(serialized).not.toContain(src.account_number); // 10-digit account number
      expect(serialized).not.toContain(outboundClearingId); // clearing account UUID
    });

    it('settlement FAILURE → 200 ack; the payer is refunded and the original REVERSED (verified at the DB)', async () => {
      const owner = newOwner();
      const AMOUNT = 4000;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT); // customer at 6000
      const balBefore = await accountBalance(src.id);

      const res = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/settlement-callback')
        .send(settlementBody(tx.id, STATUS_FAILURE));
      expect(res.status).toBe(200);

      expect(await accountBalance(src.id)).toBe(balBefore + BigInt(AMOUNT)); // refunded
      expect(await txStatus(tx.id)).toBe('REVERSED');
      expect(await compensatingCount(tx.id)).toBe(1);
    });

    // =========================================================================================
    // INBOUND over HTTP — credit once, idempotent by ref
    // =========================================================================================

    it('inbound → 200 ack; the customer is credited by account number (verified at the DB); a DUPLICATE ref → still exactly one credit', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0 });
      const AMOUNT = 2500;
      const externalRef = `rail-ref-${randomUUID()}`;

      const first = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/inbound')
        .send(inboundBody(cust.account_number, AMOUNT, externalRef));
      expect(first.status).toBe(200);
      expect(await accountBalance(cust.id)).toBe(BigInt(AMOUNT));
      expect(await inboundTxCount(cust.id)).toBe(1);

      // Replaying the same rail ref must not double-credit.
      const dup = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/inbound')
        .send(inboundBody(cust.account_number, AMOUNT, externalRef));
      expect(dup.status).toBe(200); // idempotent ack, not an error
      expect(await accountBalance(cust.id)).toBe(BigInt(AMOUNT)); // credited ONCE
      expect(await inboundTxCount(cust.id)).toBe(1);

      // The ack does not leak internal identifiers.
      const serialized = JSON.stringify(first.body);
      expect(serialized).not.toContain(owner);
      expect(serialized).not.toContain(cust.id);
      expect(serialized).not.toContain(inboundClearingId);
    });

    it('inbound to an unknown account number → 404 (INBOUND_DESTINATION_NOT_FOUND)', async () => {
      const res = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/inbound')
        .send(inboundBody(localAccountNumber(), 1000));
      expect(res.status).toBe(404);
      expectErrorDto(res.body);
    });

    // =========================================================================================
    // FULL SLICE — 5b external initiate → OTP-confirm → 5c callback (no double-move / refund)
    // =========================================================================================

    it('FULL SLICE (success): initiate external → OTP-confirm settles into clearing → SUCCESS callback reconciles WITHOUT moving money again', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const payee = await mkPayee(owner);
      const AMOUNT = 4000;

      // 5b: initiate (places a hold) → mint OTP → confirm (settles customer→clearing).
      const created = await asUser(owner)
        .post('/api/transfers/external')
        .set('Idempotency-Key', `key-${randomUUID()}`)
        .send({
          sourceAccountId: src.id,
          payeeId: payee.id,
          amount: String(AMOUNT),
          currency: MXN,
        });
      expect(created.status).toBe(201);
      const transferId = idOf(created.body);

      const code = await mintOtp(owner);
      expect(code).toBeTruthy();
      const confirmed = await asUser(owner)
        .post(`/api/transfers/${transferId}/confirm`)
        .send({ code });
      expect(confirmed.status).toBe(200);

      // Observable after 5b confirm: customer debited, hold SETTLED (ref still null), 2 legs, POSTED.
      expect((await accountRow(src.id)).balance).toBe(String(10000 - AMOUNT));
      expect(await holdRefForTx(transferId)).toBeFalsy();
      const legsAfterConfirm = (await legsForTx(transferId)).length;
      const clearingAfterConfirm = await accountBalance(outboundClearingId);

      // 5c: the rail confirms success → the callback reconciles (records the ref, moves NO money).
      const externalRef = `rail-ref-${randomUUID()}`;
      const cb = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/settlement-callback')
        .send(settlementBody(transferId, STATUS_SUCCESS, externalRef));
      expect(cb.status).toBe(200);

      expect(await holdRefForTx(transferId)).toBe(externalRef); // reconciled
      expect(await txStatus(transferId)).toBe('POSTED'); // not reversed
      expect((await accountRow(src.id)).balance).toBe(String(10000 - AMOUNT)); // NO double-move
      expect((await legsForTx(transferId)).length).toBe(legsAfterConfirm); // no new legs
      expect(await accountBalance(outboundClearingId)).toBe(clearingAfterConfirm); // clearing steady
      expect(await compensatingCount(transferId)).toBe(0);
    }, 45_000);

    it('FULL SLICE (failure): initiate external → OTP-confirm settles into clearing → FAILURE callback refunds the payer, original REVERSED', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const payee = await mkPayee(owner);
      const AMOUNT = 3500;

      const created = await asUser(owner)
        .post('/api/transfers/external')
        .set('Idempotency-Key', `key-${randomUUID()}`)
        .send({
          sourceAccountId: src.id,
          payeeId: payee.id,
          amount: String(AMOUNT),
          currency: MXN,
        });
      expect(created.status).toBe(201);
      const transferId = idOf(created.body);

      const code = await mintOtp(owner);
      const confirmed = await asUser(owner)
        .post(`/api/transfers/${transferId}/confirm`)
        .send({ code });
      expect(confirmed.status).toBe(200);
      expect((await accountRow(src.id)).balance).toBe(String(10000 - AMOUNT));
      const clearingAfterConfirm = await accountBalance(outboundClearingId);

      const cb = await asExternal(RAILS_WEBHOOK_API_KEY)
        .post('/external/rails/settlement-callback')
        .send(settlementBody(transferId, STATUS_FAILURE));
      expect(cb.status).toBe(200);

      // The payer is made whole; the original is reversed with a compensating movement.
      expect((await accountRow(src.id)).balance).toBe('10000');
      expect(await txStatus(transferId)).toBe('REVERSED');
      expect(await compensatingCount(transferId)).toBe(1);
      // The clearing account gave the money back (net in-transit returns to its pre-confirm level).
      expect(await accountBalance(outboundClearingId)).toBe(clearingAfterConfirm - BigInt(AMOUNT));
    }, 45_000);
  },
);
