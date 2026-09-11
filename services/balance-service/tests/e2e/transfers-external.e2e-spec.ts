/**
 * Spec 04 — Balance Service, Transfers: the EXTERNAL OUTBOUND `/api` HTTP surface end-to-end over
 * supertest, booting the REAL AppModule (global gateway identity guard + the exception filter + zod
 * request validation + the request-id middleware). Written FROM the developer-locked HTTP contract
 * (spec 04 step 5b brief), NOT the impl.
 *
 * Endpoints under test:
 *   POST /api/transfers/external  { sourceAccountId, payeeId, amount, currency } + Idempotency-Key
 *                                   → 201 + a PENDING Transfer DTO (expiresAt; NO destination on the wire)
 *   POST /api/transfers/:id/confirm { code }  → 200 + a POSTED Transfer DTO   (shared with internal)
 *   POST /api/transfers/:id/cancel            → 200 + a CANCELLED Transfer DTO (shared)
 *   GET  /api/pending-authorization           → { authorization }: for external, type + payeeDisplayName,
 *                                               destinationAccountNumber/destinationMaskedName null
 *
 * It proves at the HTTP edge: initiate 201 PENDING with the time-box on the wire and NO destination
 * leak (no external account ref, no clearing UUID); the DomainError→HTTP mapping (a cooling-off payee
 * is a P2b BUSINESS failure at initiate → 201 with status "FAILED" + a persisted terminal FAILED and
 * one transaction.failed event, NOT a 409; a non-owned payee → 404 with no ownership leak; zod-invalid
 * body → 400); OTP-confirm → 200 POSTED; the shared pending feed rendering an external authorization with
 * type + payeeDisplayName; cancel → 200 with the backing hold RELEASED (verified at the DB); and the
 * single-pending rule spanning external (a second initiate supersedes the first).
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (the write path hits Postgres AND Redis). beforeAll
 * TCP-probes both and fails loud if unreachable; boots AppModule (migrationsRun:true). Unique
 * owners/accounts per test; committed rows (incl. holds + payees) + minted OTP keys cleaned up per-test.
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
  insertRow,
  insertCustomer,
  insertExternalPayee,
  localAccountNumber,
  TODAY,
  MONTH_START,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[e2e] SKIPPED external-outbound transfers HTTP suite: set BALANCE_INTEGRATION=1 (and point DB_* ' +
      'at Postgres AND REDIS_* at Redis) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const MXN = 'MXN';

const suite = ENABLED ? describe : describe.skip;

suite(
  'external outbound transfers HTTP surface — initiate/confirm/cancel, authz, anti-leak (e2e, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let redis: any;
    let http: any;
    let outboundRail: string;

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
        INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-service-token',
        OTP_HASH_SECRET,
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
      outboundRail = getOutboundRail();
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

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
    }

    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      await insertCustomer(ds, owner);
      const acc = await insertRow(ds, 'account', {
        kind: 'customer',
        owner_id: owner,
        currency: MXN,
        status: 'active',
        balance: 0,
        held: 0,
        account_number: localAccountNumber(),
        spent_today_date: TODAY,
        spent_month_date: MONTH_START,
        ...overrides,
      });
      createdAccountIds.push(acc.id);
      return acc;
    }

    /** A committed enrolled payee (USABLE by default — cooling-off in the PAST). */
    async function mkPayee(
      owner: string,
      opts: { displayName?: string; coolingOffUntil?: Date } = {},
    ): Promise<any> {
      return insertExternalPayee(ds, {
        ownerId: owner,
        displayName: opts.displayName ?? 'Acme Payments',
        rail: outboundRail,
        coolingOffUntil: opts.coolingOffUntil ?? new Date(Date.now() - 60_000),
      });
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

    const asUser = (userId: string) => ({
      post: (path: string) =>
        request(http).post(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
      get: (path: string) =>
        request(http).get(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
    });

    /** POST /api/transfers/external with an explicit body (for the gate / zod edge cases). */
    async function postExternalRaw(
      owner: string,
      body: Record<string, unknown>,
      opts: { key?: string; omitKey?: boolean } = {},
    ) {
      const req = asUser(owner).post('/api/transfers/external');
      if (!opts.omitKey) req.set('Idempotency-Key', opts.key ?? `key-${randomUUID()}`);
      return req.send(body);
    }

    /** The happy-path helper: POST /api/transfers/external for a well-formed transfer. */
    async function postExternal(
      owner: string,
      sourceId: string,
      payeeId: string,
      amount: number,
      opts: { key?: string } = {},
    ) {
      return postExternalRaw(
        owner,
        { sourceAccountId: sourceId, payeeId, amount: String(amount), currency: MXN },
        { key: opts.key },
      );
    }

    async function mintOtp(owner: string): Promise<{ status: number; code?: string }> {
      const res = await asUser(owner).post('/api/otp').send({});
      const code = res.body?.code ?? res.body?.otp?.code;
      if (code) {
        trackedRedisKeys.push(`otp:${owner}`);
        trackedRedisKeys.push(
          `otp:${owner}:${createHmac('sha256', OTP_HASH_SECRET).update(`${owner}:${code}`).digest('hex')}`,
        );
      }
      return { status: res.status, code };
    }

    function idOf(body: any): string {
      const t = body?.transfer ?? body?.transaction ?? body;
      return (t?.id ?? t?.transferId ?? t?.transactionId) as string;
    }
    function statusOf(body: any): string | undefined {
      const t = body?.transfer ?? body?.transaction ?? body;
      return t?.status;
    }
    function authOf(body: any): any {
      return body?.authorization ?? null;
    }

    function expectErrorDto(body: any, code?: string): void {
      expect(body).toBeDefined();
      expect(body.error).toBeDefined();
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(body.error.message.length).toBeGreaterThan(0);
      if (code !== undefined) expect(body.error.code).toBe(code);
    }

    async function holdStatusForTx(txId: string): Promise<string | undefined> {
      const r = await ds.query(`SELECT status FROM hold WHERE transaction_id = $1`, [txId]);
      return r[0]?.status;
    }

    // ---- initiate → 201 PENDING, time-box on the wire, NO destination leak --------------------

    it('POST /api/transfers/external → 201 PENDING with expiresAt and NO destination (external ref / clearing UUID) on the wire', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const payee = await mkPayee(owner, { displayName: 'Acme Payments' });

      const res = await postExternal(owner, src.id, payee.id, 4000);
      expect(res.status).toBe(201);
      expect(statusOf(res.body)).toBe('PENDING');

      const t = res.body?.transfer ?? res.body?.transaction ?? res.body;
      expect(t.sourceAccountId).toBe(src.id); // the caller's OWN account id (mirrors AccountDto.id)
      expect('expiresAt' in t).toBe(true); // the 2-minute time-box is on the wire
      // The destination is NOT the caller's business over the write DTO: neither the external bank
      // ref nor the clearing account UUID leaks.
      expect('destinationAccountNumber' in t).toBe(false);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(payee.destination_ref); // external bank ref withheld
      expect(serialized).not.toContain(outboundRail); // the rail is internal
      expect(serialized).not.toContain(owner); // owner sub withheld
    });

    // ---- cooling-off payee → 201-FAILED (P2b business failure at initiate) ---------------------
    // P2b (spec 05 producer side, DATA-MODEL Part 2): a cooling-off payee is a BUSINESS failure at
    // initiate — no longer a bare 409. The service persists a TERMINAL FAILED external_outbound and
    // RETURNS it (201 with status "FAILED"), completes the idempotency key linked to it, and emits
    // exactly one `transaction.failed` event. Money-safety is unchanged (no hold, no ledger, balances
    // untouched) and the anti-leak wire contract still holds (no failureReason / destination_ref /
    // rail / owner sub). This is the HTTP-edge mirror of the integration-level cooling-off proof.

    it('POST /api/transfers/external to a payee still in cooling-off → 201 with status "FAILED" (P2b): a terminal FAILED external_outbound is persisted (reason PAYEE_IN_COOLING_OFF), one transaction.failed event, NO money moved / NO hold, and no anti-leak regression', async () => {
      const owner = newOwner();
      const AMOUNT = 1000;
      const src = await mkCustomer(owner, { balance: 10000 });
      const payee = await mkPayee(owner, { coolingOffUntil: new Date(Date.now() + 3_600_000) });

      const res = await postExternal(owner, src.id, payee.id, AMOUNT);

      // 201-FAILED (RETURNED, not a 4xx) — the initiate-time inversion vs. confirm.
      expect(res.status).toBe(201);
      expect(statusOf(res.body)).toBe('FAILED');
      const transferId = idOf(res.body);

      // EXACTLY ONE transaction for the owner, a terminal FAILED external_outbound with the full shape.
      const rows = await ds.query(
        `SELECT id, status, type, failure_reason, failed_at, posted_at, expires_at,
                debit_account_id, credit_account_id, payee_id
           FROM "transaction" WHERE initiated_by = $1`,
        [owner],
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.id).toBe(transferId);
      expect(row.status).toBe('FAILED');
      expect(row.type).toBe('external_outbound');
      expect(row.failure_reason).toBe('PAYEE_IN_COOLING_OFF');
      expect(row.failed_at).not.toBeNull();
      expect(row.posted_at).toBeNull();
      expect(row.expires_at).toBeNull(); // never became a live PENDING → no TTL
      expect(row.debit_account_id).toBe(src.id);
      expect(row.payee_id).toBe(payee.id);

      // MONEY-SAFETY: source balance unchanged, held zero, NO hold row at all, NO ledger legs for it.
      const acc = await ds.query(`SELECT balance, held FROM account WHERE id = $1`, [src.id]);
      expect(acc[0].balance).toBe('10000');
      expect(acc[0].held).toBe('0');
      const holds = await ds.query(`SELECT status FROM hold WHERE account_id = $1`, [src.id]);
      expect(holds).toHaveLength(0);
      const legs = await ds.query(`SELECT id FROM ledger_entry WHERE transaction_id = $1`, [
        transferId,
      ]);
      expect(legs).toHaveLength(0);

      // EXACTLY ONE outbox row for it, the enriched transaction.failed event: empty legs, payee
      // snapshot present, amount as an int64 STRING, failureReason carried ON the event (analytics
      // needs the code) — distinct from the customer-facing wire body below.
      const events = await ds.query(
        `SELECT event_type, payload FROM outbox_event WHERE transaction_id = $1`,
        [transferId],
      );
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('transaction.failed');
      const payload = events[0].payload;
      expect(payload.transaction.id).toBe(transferId);
      expect(payload.transaction.status).toBe('FAILED');
      expect(payload.transaction.postedAt ?? null).toBeNull();
      expect(Array.isArray(payload.legs)).toBe(true);
      expect(payload.legs).toHaveLength(0);
      expect(typeof payload.transaction.amount).toBe('string');
      expect(payload.transaction.amount).toBe(String(AMOUNT));
      expect(payload.transaction.failureReason ?? payload.failureReason).toBe(
        'PAYEE_IN_COOLING_OFF',
      );
      const snap = payload.transaction.payee ?? payload.payee;
      expect(snap).toBeTruthy();
      expect(snap.id).toBe(payee.id);
      expect(snap.displayName ?? snap.display_name).toBe('Acme Payments');
      expect(snap.rail).toBe(outboundRail);

      // ANTI-LEAK on the customer-facing wire body: failureReason is an internal column and MUST NOT
      // cross (neither key nor value), and the destination ref / rail / owner sub are still withheld.
      const t = res.body?.transfer ?? res.body?.transaction ?? res.body;
      expect('failureReason' in t).toBe(false);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('PAYEE_IN_COOLING_OFF');
      expect(serialized).not.toContain(payee.destination_ref);
      expect(serialized).not.toContain(outboundRail);
      expect(serialized).not.toContain(owner);
    });

    // ---- non-owned payee → 404 (anti-IDOR, no leak) -------------------------------------------

    it("POST /api/transfers/external addressing ANOTHER user's payee → 404 (domain code, no ownership leak)", async () => {
      const attacker = newOwner();
      const victim = newOwner();
      const src = await mkCustomer(attacker, { balance: 10000 });
      const victimPayee = await mkPayee(victim); // enrolled by the victim

      const res = await postExternal(attacker, src.id, victimPayee.id, 1000);
      expect(res.status).toBe(404); // never 403, never a "belongs to another user" leak
      expectErrorDto(res.body);
      expect(['PAYEE_NOT_FOUND', 'TRANSFER_NOT_FOUND']).toContain(res.body.error.code);
      expect(res.body.error.message.toLowerCase()).not.toMatch(
        /forbidden|belongs|another|owner|permission/,
      );
    });

    // ---- zod-invalid body → 400 ---------------------------------------------------------------

    it('POST /api/transfers/external rejects malformed bodies with 400 (missing payeeId, missing key, non-positive amount)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const payee = await mkPayee(owner);
      const base = { sourceAccountId: src.id, payeeId: payee.id, amount: '1000', currency: MXN };

      // Missing Idempotency-Key header.
      const noKey = await postExternalRaw(owner, base, { omitKey: true });
      expect(noKey.status).toBe(400);
      expectErrorDto(noKey.body, 'BAD_REQUEST');

      // Missing payeeId (the whole point of the external flow — no destination to address).
      const noPayee = await postExternalRaw(owner, {
        sourceAccountId: src.id,
        amount: '1000',
        currency: MXN,
      });
      expect(noPayee.status).toBe(400);

      // A non-positive amount.
      const badAmount = await postExternalRaw(owner, { ...base, amount: '-500' });
      expect(badAmount.status).toBe(400);

      // A source that is not a UUID.
      const badUuid = await postExternalRaw(owner, { ...base, sourceAccountId: 'not-a-uuid' });
      expect(badUuid.status).toBe(400);
    });

    // ---- full flow: initiate → OTP → confirm → 200 POSTED -------------------------------------

    it('full flow: POST /api/transfers/external 201 → POST /api/otp → confirm 200 POSTED (money leaves into the clearing account)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const payee = await mkPayee(owner);

      const created = await postExternal(owner, src.id, payee.id, 4000);
      expect(created.status).toBe(201);
      const transferId = idOf(created.body);

      const otp = await mintOtp(owner);
      expect(otp.status).toBe(200);

      const confirmed = await asUser(owner)
        .post(`/api/transfers/${transferId}/confirm`)
        .send({ code: otp.code });
      expect(confirmed.status).toBe(200);
      expect(statusOf(confirmed.body)).toBe('POSTED');

      // Observable at the DB: source debited by amount, held returned to 0, hold SETTLED.
      const acc = await ds.query(`SELECT balance, held FROM account WHERE id = $1`, [src.id]);
      expect(acc[0].balance).toBe('6000');
      expect(acc[0].held).toBe('0');
      expect(await holdStatusForTx(transferId)).toBe('SETTLED');
    });

    // ---- pending feed renders an external authorization -----------------------------------------

    it('GET /api/pending-authorization for an external pending shows type + payeeDisplayName; destinationAccountNumber is null; no external-ref/owner leak', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const payee = await mkPayee(owner, { displayName: 'Globex Remittance' });

      const created = await postExternal(owner, src.id, payee.id, 1500);
      const transferId = idOf(created.body);

      const res = await asUser(owner).get('/api/pending-authorization');
      expect(res.status).toBe(200);
      const auth = authOf(res.body);
      expect(auth).toBeTruthy();
      expect(idOf(auth)).toBe(transferId);
      expect(auth.type).toBe('external_outbound');
      expect(auth.payeeDisplayName).toBe('Globex Remittance');
      // The internal-only destination fields are null for an external authorization.
      expect(auth.destinationAccountNumber ?? null).toBeNull();
      expect(auth.destinationMaskedName ?? null).toBeNull();
      expect('expiresAt' in auth).toBe(true);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(payee.destination_ref); // the external bank ref never crosses
      expect(serialized).not.toContain(owner);
    });

    // ---- cancel → 200 CANCELLED and the hold is RELEASED (verified at the DB) -----------------

    it('POST /api/transfers/:id/cancel → 200 CANCELLED and the backing hold is RELEASED (funds returned)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const payee = await mkPayee(owner);

      const created = await postExternal(owner, src.id, payee.id, 2000);
      const transferId = idOf(created.body);
      // The reservation is visible at the DB before cancel.
      const before = await ds.query(`SELECT held FROM account WHERE id = $1`, [src.id]);
      expect(before[0].held).toBe('2000');

      const cancelled = await asUser(owner).post(`/api/transfers/${transferId}/cancel`).send({});
      expect(cancelled.status).toBe(200);
      expect(statusOf(cancelled.body)).toBe('CANCELLED');

      // The hold is RELEASED and the funds returned — verified at the DB.
      expect(await holdStatusForTx(transferId)).toBe('RELEASED');
      const after = await ds.query(`SELECT balance, held FROM account WHERE id = $1`, [src.id]);
      expect(after[0].held).toBe('0');
      expect(after[0].balance).toBe('10000'); // never moved

      const auth = await asUser(owner).get('/api/pending-authorization');
      expect(authOf(auth.body)).toBeNull();
    });

    // ---- single-pending spans external: a second initiate supersedes the first -----------------

    it('a pending external is THE single pending: a second POST /api/transfers/external supersedes it (first → CANCELLED, hold RELEASED), feed shows only the new one', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 20000 });
      const payee = await mkPayee(owner);

      const first = await postExternal(owner, src.id, payee.id, 1000);
      expect(first.status).toBe(201);
      const firstId = idOf(first.body);

      // A DIFFERENT amount → different fingerprint (not a soft-duplicate) → a NEW pending.
      const second = await postExternal(owner, src.id, payee.id, 2000);
      expect(second.status).toBe(201);
      const secondId = idOf(second.body);
      expect(secondId).not.toBe(firstId);

      // The single pending read shows ONLY the new one.
      const auth = await asUser(owner).get('/api/pending-authorization');
      expect(idOf(authOf(auth.body))).toBe(secondId);

      // Exactly one PENDING for the initiator; the first is retained as CANCELLED with its hold RELEASED.
      const rows = await ds.query(`SELECT id, status FROM "transaction" WHERE initiated_by = $1`, [
        owner,
      ]);
      const byId = new Map<string, string>(rows.map((r: any) => [r.id, r.status]));
      expect(byId.get(firstId)).toBe('CANCELLED');
      expect(byId.get(secondId)).toBe('PENDING');
      expect(await holdStatusForTx(firstId)).toBe('RELEASED');
      expect(await holdStatusForTx(secondId)).toBe('PLACED');

      // held reflects ONLY the live (second) reservation.
      const acc = await ds.query(`SELECT held FROM account WHERE id = $1`, [src.id]);
      expect(acc[0].held).toBe('2000');
    });
  },
);
