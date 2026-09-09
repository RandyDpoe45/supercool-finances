/**
 * Spec 04 — Balance Service, Step-4b: the transfers HTTP surface (`/api`) end-to-end over supertest,
 * booting the REAL AppModule (global gateway identity guard + the extended exception filter + the
 * zod request validation + the request-id middleware). Written FROM the developer-locked HTTP
 * contract, NOT from the implementor's code.
 *
 * Endpoints under test:
 *   POST /api/transfers                 (header Idempotency-Key required) → 201 + a PENDING Transfer DTO
 *   POST /api/otp                                                          → 201 + { code, ttlSeconds }
 *   POST /api/transfers/:id/confirm     (body { code })                    → 200 + a POSTED Transfer DTO
 *   GET  /api/pending-authorizations                                       → the caller's PENDING transfers
 *
 * It proves the DomainError→HTTP mapping AT THE EDGE (the response `error.code` is the DOMAIN code,
 * not the status vocabulary), the zod 400s, object-level authorization (X-User-Id scoping; a
 * non-owned account/transfer → 404, never 403/leak), and the anti-leak whitelist DTO (no
 * `initiatedBy`/owner id on the wire). A wrong status, a status-derived code where a domain code is
 * required, an authorization leak, or a leaked owner id FAILS a test here.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (the write path hits Postgres AND Redis). beforeAll
 * TCP-probes both and fails loud if unreachable; boots AppModule (migrationsRun:true). Unique
 * owners/accounts per test; committed rows + minted OTP keys cleaned up per-test.
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=… REDIS_HOST=… REDIS_PORT=…] npm run test:e2e
 */
import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { getAppModule, getRedisClientToken, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import { insertRow, TODAY, MONTH_START } from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[e2e] SKIPPED transfers HTTP suite: set BALANCE_INTEGRATION=1 (and point DB_* at Postgres AND ' +
      'REDIS_* at Redis) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';
const MXN = 'MXN';

const suite = ENABLED ? describe : describe.skip;

suite('transfers HTTP surface — mappings, authz, anti-leak (e2e, needs Postgres + Redis)', () => {
  let app: INestApplication;
  let ds: any;
  let redis: any;
  let http: any;

  let createdAccountIds: string[] = [];
  let trackedOwners: string[] = [];
  let trackedOtpKeys: string[] = [];

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
  }, 60_000);

  afterEach(async () => {
    const ids = createdAccountIds;
    const owners = trackedOwners;
    const otpKeys = Array.from(new Set(trackedOtpKeys));
    createdAccountIds = [];
    trackedOwners = [];
    trackedOtpKeys = [];
    if (redis && otpKeys.length) {
      try {
        await redis.del(...otpKeys);
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

  // ---- helpers --------------------------------------------------------------------------

  function newOwner(): string {
    const o = `sub-${randomUUID()}`;
    trackedOwners.push(o);
    return o;
  }

  async function mkCustomer(owner: string, overrides: Record<string, unknown> = {}): Promise<any> {
    const acc = await insertRow(ds, 'account', {
      kind: 'customer',
      owner_id: owner,
      currency: MXN,
      status: 'active',
      balance: 0,
      held: 0,
      spent_today_date: TODAY,
      spent_month_date: MONTH_START,
      ...overrides,
    });
    createdAccountIds.push(acc.id);
    return acc;
  }

  async function cleanup(ids: string[], owners: string[]): Promise<void> {
    if (!ids.length && !owners.length) return;
    const txRows = await ds.query(
      `SELECT id FROM "transaction"
        WHERE debit_account_id = ANY($1) OR credit_account_id = ANY($1) OR initiated_by = ANY($2)
        UNION SELECT DISTINCT transaction_id AS id FROM ledger_entry WHERE account_id = ANY($1)`,
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
    if (owners.length)
      await ds.query(`DELETE FROM idempotency_key WHERE owner_id = ANY($1)`, [owners]);
    if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
  }

  const asUser = (userId: string) => ({
    post: (path: string) =>
      request(http).post(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
    get: (path: string) =>
      request(http).get(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
  });

  function transferBody(
    source: string,
    dest: string,
    amount: number,
    extra: Record<string, unknown> = {},
  ) {
    // Money is a minor-unit digit STRING on the wire (never a JS number — int64 precision).
    return {
      sourceAccountId: source,
      destinationAccountId: dest,
      amount: String(amount),
      currency: MXN,
      ...extra,
    };
  }

  async function postTransfer(
    owner: string,
    source: string,
    dest: string,
    amount: number,
    opts: { key?: string; confirmDuplicate?: boolean } = {},
  ) {
    const body = transferBody(
      source,
      dest,
      amount,
      opts.confirmDuplicate !== undefined ? { confirmDuplicate: opts.confirmDuplicate } : {},
    );
    return asUser(owner)
      .post('/api/transfers')
      .set('Idempotency-Key', opts.key ?? `key-${randomUUID()}`)
      .send(body);
  }

  async function mintOtp(
    owner: string,
  ): Promise<{ status: number; code?: string; ttlSeconds?: number; body: any }> {
    const res = await asUser(owner).post('/api/otp').send({});
    const code = res.body?.code ?? res.body?.otp?.code;
    if (code) {
      trackedOtpKeys.push(`otp:${owner}`);
      trackedOtpKeys.push(
        `otp:${owner}:${createHmac('sha256', OTP_HASH_SECRET).update(`${owner}:${code}`).digest('hex')}`,
      );
    }
    return {
      status: res.status,
      code,
      ttlSeconds: res.body?.ttlSeconds ?? res.body?.otp?.ttlSeconds,
      body: res.body,
    };
  }

  function idOf(body: any): string {
    const t = body?.transfer ?? body?.transaction ?? body;
    return (t?.id ?? t?.transferId ?? t?.transactionId) as string;
  }
  function statusOf(body: any): string | undefined {
    const t = body?.transfer ?? body?.transaction ?? body;
    return t?.status;
  }
  function pendingList(body: any): any[] {
    const list =
      body?.authorizations ??
      body?.pendingAuthorizations ??
      body?.transfers ??
      body?.items ??
      body?.pending ??
      (Array.isArray(body) ? body : []);
    return Array.isArray(list) ? list : [];
  }

  function expectErrorDto(body: any, code?: string): void {
    expect(body).toBeDefined();
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
    if (code !== undefined) expect(body.error.code).toBe(code);
  }

  // ---- happy path: initiate (PENDING), otp, confirm (POSTED), list ----------------------

  it('POST /api/transfers → 201 PENDING with source/dest echoed and NO initiatedBy/owner leak in the DTO', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 10000 });
    const dst = await mkCustomer(newOwner(), { balance: 0 });

    const res = await postTransfer(owner, src.id, dst.id, 4000);
    expect(res.status).toBe(201);
    expect(statusOf(res.body)).toBe('PENDING');

    const serialized = JSON.stringify(res.body);
    // Whitelist DTO: the account ids the caller sent are echoed, but the owner sub (initiatedBy) is
    // NEVER on the wire (a leaked owner id is a serialization security defect).
    expect(serialized).toContain(src.id);
    expect(serialized).toContain(dst.id);
    expect(serialized).not.toContain(owner);
    expect(serialized.toLowerCase()).not.toContain('initiatedby');
  });

  it('POST /api/otp → 201 { code, ttlSeconds } and POST /api/transfers/:id/confirm → 200 POSTED', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 10000 });
    const dst = await mkCustomer(newOwner(), { balance: 0 });

    const created = await postTransfer(owner, src.id, dst.id, 4000);
    const transferId = idOf(created.body);

    const otp = await mintOtp(owner);
    expect(otp.status).toBe(201);
    expect(typeof otp.code).toBe('string');
    expect((otp.code as string).length).toBeGreaterThan(0);
    expect(typeof otp.ttlSeconds).toBe('number');
    expect(otp.ttlSeconds as number).toBeGreaterThan(0);

    const confirmed = await asUser(owner)
      .post(`/api/transfers/${transferId}/confirm`)
      .send({ code: otp.code });
    expect(confirmed.status).toBe(200);
    expect(statusOf(confirmed.body)).toBe('POSTED');

    // The movement is observable in the DB: source debited, destination credited.
    const bal = await ds.query(`SELECT id, balance FROM account WHERE id = ANY($1)`, [
      [src.id, dst.id],
    ]);
    const byId = new Map<string, string>(bal.map((r: any) => [r.id, r.balance]));
    expect(byId.get(src.id)).toBe('6000');
    expect(byId.get(dst.id)).toBe('4000');
  });

  it("GET /api/pending-authorizations lists the caller's PENDING transfer", async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 10000 });
    const dst = await mkCustomer(newOwner(), { balance: 0 });

    const created = await postTransfer(owner, src.id, dst.id, 1000);
    const transferId = idOf(created.body);

    const res = await asUser(owner).get('/api/pending-authorizations');
    expect(res.status).toBe(200);
    const ids = pendingList(res.body).map((t) => idOf(t));
    expect(ids).toContain(transferId);
  });

  // ---- zod validation → 400 -------------------------------------------------------------

  it('POST /api/transfers without an Idempotency-Key → 400', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 10000 });
    const dst = await mkCustomer(newOwner(), { balance: 0 });

    const res = await asUser(owner)
      .post('/api/transfers')
      .send(transferBody(src.id, dst.id, 1000));
    expect(res.status).toBe(400);
    expectErrorDto(res.body, 'BAD_REQUEST');
  });

  it('POST /api/transfers with a malformed body → 400 (bad uuid, negative amount, missing field)', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 10000 });
    const dst = await mkCustomer(newOwner(), { balance: 0 });

    const badUuid = await asUser(owner)
      .post('/api/transfers')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({ ...transferBody(src.id, dst.id, 1000), sourceAccountId: 'not-a-uuid' });
    expect(badUuid.status).toBe(400);
    expectErrorDto(badUuid.body, 'BAD_REQUEST');

    const negative = await asUser(owner)
      .post('/api/transfers')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send(transferBody(src.id, dst.id, -500));
    expect(negative.status).toBe(400);

    const missing = await asUser(owner)
      .post('/api/transfers')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({ sourceAccountId: src.id, amount: 1000, currency: MXN }); // no destinationAccountId
    expect(missing.status).toBe(400);
  });

  // ---- object-level authorization (anti-IDOR) → 404, never 403/leak ---------------------

  it('POST /api/transfers debiting a source account owned by ANOTHER user → 404 (domain code, no leak)', async () => {
    const attacker = newOwner();
    const victim = newOwner();
    const victimAcc = await mkCustomer(victim, { balance: 10000 });
    const attackerAcc = await mkCustomer(attacker, { balance: 0 });

    // The attacker tries to pull funds OUT of the victim's account into their own.
    const res = await asUser(attacker)
      .post('/api/transfers')
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send(transferBody(victimAcc.id, attackerAcc.id, 5000));

    expect(res.status).toBe(404); // never 403, never a "belongs to another user" leak
    expectErrorDto(res.body);
    expect(['ACCOUNT_NOT_FOUND', 'TRANSFER_NOT_FOUND']).toContain(res.body.error.code);
    expect(res.body.error.message.toLowerCase()).not.toMatch(
      /forbidden|belongs|another|owner|permission/,
    );
  });

  it("a DIFFERENT user cannot see or confirm another user's transfer (X-User-Id scoping) → 404", async () => {
    const ownerA = newOwner();
    const ownerB = newOwner();
    const srcA = await mkCustomer(ownerA, { balance: 10000 });
    const dst = await mkCustomer(newOwner(), { balance: 0 });

    const created = await postTransfer(ownerA, srcA.id, dst.id, 1000);
    const transferId = idOf(created.body);

    // B cannot see A's pending transfer.
    const listB = await asUser(ownerB).get('/api/pending-authorizations');
    expect(listB.status).toBe(200);
    expect(pendingList(listB.body).map((t) => idOf(t))).not.toContain(transferId);

    // B cannot confirm A's transfer — it is 404 for B (as if it does not exist), never 403.
    const otpB = await mintOtp(ownerB); // B mints their OWN code; it must not authorize A's transfer
    const confirmByB = await asUser(ownerB)
      .post(`/api/transfers/${transferId}/confirm`)
      .send({ code: otpB.code ?? '000000' });
    expect(confirmByB.status).toBe(404);
    expectErrorDto(confirmByB.body);

    // A's transfer is still PENDING (B's attempt did not touch it).
    const stillPending = await ds.query(`SELECT status FROM "transaction" WHERE id = $1`, [
      transferId,
    ]);
    expect(stillPending[0].status).toBe('PENDING');
  });

  // ---- DomainError → HTTP status + DOMAIN code at the edge -------------------------------

  it('confirm on an under-funded transfer → 422 with error.code INSUFFICIENT_FUNDS (domain code, not UNPROCESSABLE_ENTITY)', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 1000 }); // available = 1000
    const dst = await mkCustomer(newOwner(), { balance: 0 });

    const created = await postTransfer(owner, src.id, dst.id, 9000); // more than available
    const transferId = idOf(created.body);
    expect(created.status).toBe(201); // accepted PENDING (no funds check at initiate)

    const otp = await mintOtp(owner);
    const res = await asUser(owner)
      .post(`/api/transfers/${transferId}/confirm`)
      .send({ code: otp.code });

    expect(res.status).toBe(422);
    expectErrorDto(res.body, 'INSUFFICIENT_FUNDS');

    // Not posted: still PENDING, balances unchanged.
    const after = await ds.query(`SELECT balance FROM account WHERE id = $1`, [src.id]);
    expect(after[0].balance).toBe('1000');
    const st = await ds.query(`SELECT status FROM "transaction" WHERE id = $1`, [transferId]);
    expect(st[0].status).toBe('PENDING');
  });

  it('confirm with a WRONG OTP → 401 with error.code INVALID_OTP', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 10000 });
    const dst = await mkCustomer(newOwner(), { balance: 0 });

    const created = await postTransfer(owner, src.id, dst.id, 1000);
    const transferId = idOf(created.body);
    const otp = await mintOtp(owner);
    const wrong =
      (otp.code as string).slice(0, -1) + ((otp.code as string).endsWith('0') ? '1' : '0');

    const res = await asUser(owner)
      .post(`/api/transfers/${transferId}/confirm`)
      .send({ code: wrong });
    expect(res.status).toBe(401);
    expectErrorDto(res.body, 'INVALID_OTP');
  });

  it('a second POST /api/otp while one is active → 409 with error.code OTP_ALREADY_ACTIVE', async () => {
    const owner = newOwner();
    const first = await mintOtp(owner);
    expect(first.status).toBe(201);

    const second = await asUser(owner).post('/api/otp').send({});
    expect(second.status).toBe(409);
    expectErrorDto(second.body, 'OTP_ALREADY_ACTIVE');
  });

  it('a semantically identical transfer within 60s under a DIFFERENT key → 409 SUSPECTED_DUPLICATE; confirmDuplicate overrides', async () => {
    const owner = newOwner();
    const src = await mkCustomer(owner, { balance: 20000 });
    const dst = await mkCustomer(newOwner(), { balance: 0 });

    const first = await postTransfer(owner, src.id, dst.id, 1500);
    expect(first.status).toBe(201);

    const dup = await postTransfer(owner, src.id, dst.id, 1500); // different key, same fingerprint
    expect(dup.status).toBe(409);
    expectErrorDto(dup.body, 'SUSPECTED_DUPLICATE');

    const override = await postTransfer(owner, src.id, dst.id, 1500, { confirmDuplicate: true });
    expect(override.status).toBe(201); // an explicit repeat is allowed
    expect(idOf(override.body)).not.toBe(idOf(first.body));
  });
});
