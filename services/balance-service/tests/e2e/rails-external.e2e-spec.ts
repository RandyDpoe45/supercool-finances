/**
 * Spec 04 — Balance Service, step 5c: the `/external` RAIL-WEBHOOK HTTP surface end-to-end over
 * supertest, booting the REAL AppModule (the global signature guard scoped to the `external` prefix
 * + the exception filter + zod request validation). Written FROM the developer-locked HTTP contract
 * (spec 04 "Mocked external rails" + the `/external` endpoints line — the HMAC-signature scheme),
 * NOT the impl.
 *
 * AUTH CONTRACT (spec 04, this step replaces the old static `X-Api-Key`):
 *   `/external` requests authenticate with a Stripe-style request signature —
 *     header `X-Rail-Signature: t=<unix-seconds>,v1=<hex>`
 *   where `v1 == HMAC-SHA256(RAILS_WEBHOOK_SIGNING_SECRET, "<t>.<rawBody>")` computed over the
 *   RAW request-body bytes (not reparsed JSON) and compared constant-time. A missing/malformed
 *   header, a signature mismatch, or a timestamp outside ±300s (replay guard) → 401. The static
 *   `X-Api-Key` is GONE.
 *
 * Endpoints under test:
 *   POST /external/rails/settlement-callback { transactionId, status, externalRef }  (X-Rail-Signature)
 *       → 200 ack; SUCCESS reconciles (records externalRef, NO new ledger); FAILURE reverses
 *         (clearing → customer refund).
 *   POST /external/rails/inbound { accountNumber, amount, currency, externalRef }    (X-Rail-Signature)
 *       → 200 ack; credits the customer by account number; idempotent by externalRef.
 *
 * It proves at the HTTP edge:
 *   - AUTH is a DISTINCT trust domain, verified over the RAW BYTES: a valid signature runs the
 *     handler; a MISSING / MALFORMED header, a WRONG signature (right shape, wrong secret / random
 *     hex), a STALE (`t = now − 400s`) or FUTURE (`t = now + 400s`) timestamp, and a TAMPERED body
 *     (a signature that signed a DIFFERENT body) each → 401 with NO state change; neither the
 *     `/internal` `X-Service-Token` nor the `/api` gateway `X-User-Id` authenticates `/external`.
 *   - zod-invalid bodies (with a VALID signature) → 400.
 *   - SUCCESS reconcile → 200 with NO new ledger (verified at the DB); FAILURE reversal → 200 with
 *     the payer refunded (verified at the DB); INBOUND credit → 200 with the customer credited
 *     (verified at the DB); a DUPLICATE inbound ref → still exactly one credit.
 *   - the ack DTO leaks no internal fields (owner sub, account UUID/number, balances).
 *   - a FULL SLICE: 5b external initiate → OTP-confirm (settle to clearing) → 5c SUCCESS callback
 *     reconciles WITHOUT moving money again; and a FAILURE variant refunds the payer.
 *
 * CRITICAL WIRING: the app is created with `{ rawBody: true }` so `req.rawBody` is populated — the
 * guard verifies the signature over those exact bytes. For every valid `/external` request the body
 * is built as a STRING and THAT string is sent (Content-Type: application/json) so supertest does
 * not re-serialize to different bytes than were signed. `postSigned()` / `postRaw()` keep this DRY.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (Postgres AND Redis). beforeAll TCP-probes both and
 * fails loud if unreachable; boots AppModule (migrationsRun:true). Unique owners/accounts per test;
 * committed rows + minted OTP keys cleaned up per-test.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=… RAILS_WEBHOOK_SIGNING_SECRET=…]
 *   npm run test:e2e
 */
import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
  getAppModule,
  getRedisClientToken,
  getOutboundRail,
  getRailsWebhookSigningSecret,
  railSignatureHeader,
  tcpProbe,
} from '../support/harness';
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
const MXN = 'MXN';

// A secret that is DELIBERATELY NOT the app's signing secret — signing with it yields a valid-shape
// header whose `v1` will not match the guard's recomputation (proves the mismatch → 401 path).
const WRONG_SECRET = 'wrong-rails-signing-secret-0123456789';

// The replay window is ±300s; 400s is comfortably outside it in either direction.
const OUTSIDE_WINDOW_SECONDS = 400;
const nowSec = (): number => Math.floor(Date.now() / 1000);

// Settlement `status` literal — DEVELOPER-LOCKED to lowercase `'success'` / `'failure'` (the wire
// schema is `z.enum(['success','failure'])`, so an uppercase body would 400); ambiguity resolved.
const STATUS_SUCCESS = 'success';
const STATUS_FAILURE = 'failure';

const suite = ENABLED ? describe : describe.skip;

suite(
  'external-rail webhooks HTTP surface (step 5c) — HMAC X-Rail-Signature auth, reconcile/reverse/inbound, anti-leak (e2e, needs Postgres + Redis)',
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

      // Boot the app with the SAME signing secret `railSignatureHeader` signs with (the fixture
      // secret), so a correctly-signed request verifies. Pinning the boot value to
      // `getRailsWebhookSigningSecret()` decouples this from whatever the shell env carries — a
      // correctly-signed request must verify, and a wrong/stale/tampered one must not.
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
        RAILS_WEBHOOK_SIGNING_SECRET: getRailsWebhookSigningSecret(),
      });
      for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

      // Guard against a self-defeating "wrong secret" case: it must differ from the real one.
      if (WRONG_SECRET === getRailsWebhookSigningSecret()) {
        throw new Error('[e2e] WRONG_SECRET must differ from the app signing secret.');
      }

      const AppModule = getAppModule();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      // rawBody:true → Nest captures req.rawBody; the guard verifies the signature over these exact
      // bytes. WITHOUT this every signed request 401s (there is nothing to recompute the HMAC over).
      app = moduleRef.createNestApplication({ rawBody: true });
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

    // ---- signing / posting seam -------------------------------------------------------------
    // Sign the RAW bytes actually sent: build the body as a STRING, sign THAT string, and send THAT
    // string (Content-Type: application/json) so supertest never re-serializes to different bytes.

    function postRaw(path: string, rawBody: string, sig?: string) {
      let req = request(http).post(path).set('Content-Type', 'application/json');
      if (sig !== undefined) req = req.set('X-Rail-Signature', sig);
      return req.send(rawBody);
    }

    /** POST `payload` correctly signed over its own serialized bytes; `sigOverride` (a header value
     *  computed over DIFFERENT bytes / with a wrong secret / stale t) drives the negative cases. */
    function postSigned(path: string, payload: unknown, sigOverride?: string) {
      const body = JSON.stringify(payload);
      const sig = sigOverride ?? railSignatureHeader(body);
      return postRaw(path, body, sig);
    }

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
    // AUTH — the /external trust domain: HMAC X-Rail-Signature over the RAW body, ±300s window
    // =========================================================================================

    it('settlement-callback with NO X-Rail-Signature → 401 and NO state change', async () => {
      const owner = newOwner();
      const { src, tx } = await seedSettledOutbound(owner, 3000);
      const before = await accountRow(src.id);

      // A FAILURE body: if the guard were bypassed the handler would refund + reverse — so an
      // unchanged balance / POSTED status / zero compensating rows proves the guard blocked first.
      const res = await postRaw(
        '/external/rails/settlement-callback',
        JSON.stringify(settlementBody(tx.id, STATUS_FAILURE)),
        /* no signature */
      );
      expect(res.status).toBe(401);

      expect((await accountRow(src.id)).balance).toBe(before.balance);
      expect(await txStatus(tx.id)).toBe('POSTED');
      expect(await compensatingCount(tx.id)).toBe(0);
    });

    it('settlement-callback with a MALFORMED X-Rail-Signature → 401 and NO state change', async () => {
      const owner = newOwner();
      const { src, tx } = await seedSettledOutbound(owner, 3000);
      const before = await accountRow(src.id);
      const bodyPayload = settlementBody(tx.id, STATUS_FAILURE);

      const malformed = [
        'garbage', // not even key=value pairs
        'v1=abcdef', // no `t`
        `t=${nowSec()}`, // no `v1`
        't=notanumber,v1=deadbeef', // `t` is not a unix-seconds integer
        `t=${nowSec()},v1=`, // empty `v1`
      ];
      for (const header of malformed) {
        const res = await postRaw(
          '/external/rails/settlement-callback',
          JSON.stringify(bodyPayload),
          header,
        );
        expect(res.status).toBe(401);
      }

      // None of the malformed attempts touched money.
      expect((await accountRow(src.id)).balance).toBe(before.balance);
      expect(await txStatus(tx.id)).toBe('POSTED');
      expect(await compensatingCount(tx.id)).toBe(0);
    });

    it('settlement-callback with a WRONG signature (right shape, wrong secret / random hex) → 401 and NO state change', async () => {
      const owner = newOwner();
      const { src, tx } = await seedSettledOutbound(owner, 3000);
      const before = await accountRow(src.id);
      const body = JSON.stringify(settlementBody(tx.id, STATUS_FAILURE));

      // v1 = HMAC over the correct bytes but with the WRONG secret → mismatch.
      const wrongSecretSig = railSignatureHeader(body, { secret: WRONG_SECRET });
      const r1 = await postRaw('/external/rails/settlement-callback', body, wrongSecretSig);
      expect(r1.status).toBe(401);

      // v1 = arbitrary hex of the right length, valid `t` → mismatch.
      const randomHexSig = `t=${nowSec()},v1=${'deadbeef'.repeat(8)}`;
      const r2 = await postRaw('/external/rails/settlement-callback', body, randomHexSig);
      expect(r2.status).toBe(401);

      expect((await accountRow(src.id)).balance).toBe(before.balance);
      expect(await txStatus(tx.id)).toBe('POSTED');
      expect(await compensatingCount(tx.id)).toBe(0);
    });

    it('settlement-callback with a VALID signature whose v1 hex is UPPERCASE → passes the guard (hex is case-insensitive), reaching the handler (unknown txn → 404, not 401)', async () => {
      // A correctly-signed request whose v1 is emitted in UPPER-case hex must still verify — hex is
      // case-insensitive. Proof by discrimination: if the guard rejected the case it would 401; instead
      // it passes to the handler, which 404s on an unknown transaction id (a wrong sig 401s above).
      const unknownTxId = '11111111-1111-4111-8111-111111111111';
      const body = JSON.stringify(settlementBody(unknownTxId, STATUS_FAILURE));
      const upperSig = railSignatureHeader(body).replace(
        /v1=([0-9a-f]+)/,
        (_m, h) => `v1=${h.toUpperCase()}`,
      );
      const res = await postRaw('/external/rails/settlement-callback', body, upperSig);
      expect(res.status).toBe(404);
    });

    it('settlement-callback with a STALE (t = now − 400s) or FUTURE (t = now + 400s) timestamp → 401 (replay window ±300s), NO state change', async () => {
      const owner = newOwner();
      const { src, tx } = await seedSettledOutbound(owner, 3000);
      const before = await accountRow(src.id);
      const body = JSON.stringify(settlementBody(tx.id, STATUS_FAILURE));

      // Signature is otherwise VALID over `<t>.<body>` — only the timestamp is out of the window.
      const staleSig = railSignatureHeader(body, { t: nowSec() - OUTSIDE_WINDOW_SECONDS });
      const stale = await postRaw('/external/rails/settlement-callback', body, staleSig);
      expect(stale.status).toBe(401);

      const futureSig = railSignatureHeader(body, { t: nowSec() + OUTSIDE_WINDOW_SECONDS });
      const future = await postRaw('/external/rails/settlement-callback', body, futureSig);
      expect(future.status).toBe(401);

      expect((await accountRow(src.id)).balance).toBe(before.balance);
      expect(await txStatus(tx.id)).toBe('POSTED');
      expect(await compensatingCount(tx.id)).toBe(0);
    });

    it('TAMPERED body → 401 and NO credit: a signature that signed a DIFFERENT body does not authorize the sent body', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0 });
      const externalRef = `rail-ref-${randomUUID()}`;

      // Sign a small-credit body, then SEND a large-credit body with that same signature.
      const signedPayload = inboundBody(cust.account_number, 100, externalRef);
      const sentPayload = inboundBody(cust.account_number, 999999, externalRef);
      const sigForSigned = railSignatureHeader(JSON.stringify(signedPayload));

      const res = await postRaw(
        '/external/rails/inbound',
        JSON.stringify(sentPayload),
        sigForSigned,
      );
      expect(res.status).toBe(401);

      // Neither the signed 100 nor the sent 999999 was credited — the raw-body binding held.
      expect((await accountRow(cust.id)).balance).toBe('0');
      expect(await inboundTxCount(cust.id)).toBe(0);
    });

    it('neither the /internal X-Service-Token nor the /api X-User-Id authenticates /external → 401', async () => {
      const owner = newOwner();
      const { tx } = await seedSettledOutbound(owner, 3000);

      const res = await request(http)
        .post('/external/rails/settlement-callback')
        .set('Content-Type', 'application/json')
        .set('X-Service-Token', INTERNAL_SERVICE_TOKEN) // valid for /internal, NOT for /external
        .send(JSON.stringify(settlementBody(tx.id, STATUS_SUCCESS)));
      expect(res.status).toBe(401);

      const res2 = await request(http)
        .post('/external/rails/inbound')
        .set('Content-Type', 'application/json')
        .set('X-User-Id', owner)
        .set('X-Roles', 'customer')
        .send(JSON.stringify(inboundBody(localAccountNumber(), 1000)));
      expect(res2.status).toBe(401);
    });

    it('inbound with a missing / wrong signature → 401 and NO credit', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0 });
      const body = JSON.stringify(inboundBody(cust.account_number, 1000));

      const missing = await postRaw('/external/rails/inbound', body /* no sig */);
      expect(missing.status).toBe(401);

      const wrong = await postRaw(
        '/external/rails/inbound',
        body,
        railSignatureHeader(body, { secret: WRONG_SECRET }),
      );
      expect(wrong.status).toBe(401);

      expect((await accountRow(cust.id)).balance).toBe('0'); // never credited
      expect(await inboundTxCount(cust.id)).toBe(0);
    });

    // =========================================================================================
    // VALIDATION — a VALID signature over a schema-invalid body → 400 (guard passes, pipe rejects)
    // =========================================================================================

    it('malformed bodies (validly signed) → 400 (settlement missing transactionId; inbound missing accountNumber / non-positive amount)', async () => {
      const badSettle = await postSigned('/external/rails/settlement-callback', {
        status: STATUS_SUCCESS,
        externalRef: 'r1',
      }); // no transactionId
      expect(badSettle.status).toBe(400);
      expectErrorDto(badSettle.body);

      const noAccount = await postSigned('/external/rails/inbound', {
        amount: '1000',
        currency: MXN,
        externalRef: 'r2',
      }); // no accountNumber
      expect(noAccount.status).toBe(400);

      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0 });
      const badAmount = await postSigned('/external/rails/inbound', {
        ...inboundBody(cust.account_number, 1000),
        amount: '-500',
      });
      expect(badAmount.status).toBe(400);
      expect((await accountRow(cust.id)).balance).toBe('0');
    });

    // =========================================================================================
    // SUCCESS reconcile / FAILURE reversal over HTTP (VALID signature) — verified at the DB
    // =========================================================================================

    it('settlement SUCCESS (validly signed) → 200 ack; reconcile records the hold ref, moves NO money (verified at the DB); ack leaks no internal fields', async () => {
      const owner = newOwner();
      const AMOUNT = 4000;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT);
      const before = await accountRow(src.id);
      const externalRef = `rail-ref-${randomUUID()}`;

      const res = await postSigned(
        '/external/rails/settlement-callback',
        settlementBody(tx.id, STATUS_SUCCESS, externalRef),
      );
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

    it('settlement FAILURE (validly signed) → 200 ack; the payer is refunded and the original REVERSED (verified at the DB)', async () => {
      const owner = newOwner();
      const AMOUNT = 4000;
      const { src, tx } = await seedSettledOutbound(owner, AMOUNT); // customer at 6000
      const balBefore = await accountBalance(src.id);

      const res = await postSigned(
        '/external/rails/settlement-callback',
        settlementBody(tx.id, STATUS_FAILURE),
      );
      expect(res.status).toBe(200);

      expect(await accountBalance(src.id)).toBe(balBefore + BigInt(AMOUNT)); // refunded
      expect(await txStatus(tx.id)).toBe('REVERSED');
      expect(await compensatingCount(tx.id)).toBe(1);
    });

    // =========================================================================================
    // INBOUND over HTTP (VALID signature) — credit once, idempotent by ref
    // =========================================================================================

    it('inbound (validly signed) → 200 ack; the customer is credited by account number (verified at the DB); a DUPLICATE ref → still exactly one credit', async () => {
      const owner = newOwner();
      const cust = await mkCustomer(owner, { balance: 0 });
      const AMOUNT = 2500;
      const externalRef = `rail-ref-${randomUUID()}`;

      const first = await postSigned(
        '/external/rails/inbound',
        inboundBody(cust.account_number, AMOUNT, externalRef),
      );
      expect(first.status).toBe(200);
      expect(await accountBalance(cust.id)).toBe(BigInt(AMOUNT));
      expect(await inboundTxCount(cust.id)).toBe(1);

      // Replaying the same rail ref must not double-credit. Sign the replay independently (a fresh
      // `t`) so this proves per-ref idempotency, not signature-level replay rejection.
      const dup = await postSigned(
        '/external/rails/inbound',
        inboundBody(cust.account_number, AMOUNT, externalRef),
      );
      expect(dup.status).toBe(200); // idempotent ack, not an error
      expect(await accountBalance(cust.id)).toBe(BigInt(AMOUNT)); // credited ONCE
      expect(await inboundTxCount(cust.id)).toBe(1);

      // The ack does not leak internal identifiers.
      const serialized = JSON.stringify(first.body);
      expect(serialized).not.toContain(owner);
      expect(serialized).not.toContain(cust.id);
      expect(serialized).not.toContain(inboundClearingId);
    });

    it('inbound (validly signed) to an unknown account number → 404 (INBOUND_DESTINATION_NOT_FOUND)', async () => {
      const res = await postSigned(
        '/external/rails/inbound',
        inboundBody(localAccountNumber(), 1000),
      );
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
      const cb = await postSigned(
        '/external/rails/settlement-callback',
        settlementBody(transferId, STATUS_SUCCESS, externalRef),
      );
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

      const cb = await postSigned(
        '/external/rails/settlement-callback',
        settlementBody(transferId, STATUS_FAILURE),
      );
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
