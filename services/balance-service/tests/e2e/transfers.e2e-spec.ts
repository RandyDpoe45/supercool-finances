/**
 * Spec 04 — Balance Service, Transfers + confirmation-of-payee: the `/api` HTTP surface end-to-end
 * over supertest, booting the REAL AppModule (global gateway identity guard + the extended
 * exception filter + zod request validation + the request-id middleware). Written FROM the
 * developer-locked HTTP contract, NOT from the implementor's code.
 *
 * Endpoints under test:
 *   POST /api/transfers/resolve-destination  (body {accountNumber})  → 200 {maskedName, currency, confirmationToken}
 *   POST /api/transfers                       (Idempotency-Key hdr)   → 201 + a PENDING Transfer DTO (with expiresAt)
 *   POST /api/otp                                                      → 201 + {code, ttlSeconds}
 *   POST /api/transfers/:id/confirm           (body {code})            → 200 + a POSTED Transfer DTO
 *   POST /api/transfers/:id/cancel                                     → 200 + a CANCELLED Transfer DTO
 *   GET  /api/pending-authorization                                    → { authorization: PendingAuthorizationDto | null }
 *   GET  /api/accounts                                                 → AccountDto[] (now with accountNumber)
 *
 * It proves: the resolve DTO whitelist (masked name over the wire, NO raw name/phone/email leak);
 * the resolve→initiate gate (a well-formed but unissued token → 409 DESTINATION_NOT_CONFIRMED; a
 * bad account number → 400 zod); the DomainError→HTTP mapping AT THE EDGE (the response `error.code`
 * is the DOMAIN code, incl. 410 TRANSFER_EXPIRED / 409 TRANSFER_NOT_PENDING); object-level
 * authorization (X-User-Id scoping; non-owned → 404, never a leak); single + time-boxed pending
 * (auto-supersede across two initiates, cancel, overdue-confirm → 410); and the anti-leak whitelist
 * DTOs after the PR #19 review fix — the WRITE Transfer DTO (initiate/confirm/cancel) exposes the
 * caller's OWN `sourceAccountId` + `expiresAt` but NEVER `destinationAccountNumber` / the raw credit
 * UUID / `initiatedBy` / owner; the singular PendingAuthorizationDto DOES carry the destination as a
 * human account NUMBER + masked name. A wrong status, a status-derived code, an authorization leak,
 * a leaked owner id, a leaked destination UUID, or a leaked raw name FAILS a test.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (the write path hits Postgres AND Redis). beforeAll
 * TCP-probes both and fails loud if unreachable; boots AppModule (migrationsRun:true). Unique
 * owners/accounts per test; committed rows + minted OTP/confirmation keys cleaned up per-test.
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
import {
  insertRow,
  insertCustomer,
  insertTransaction,
  localAccountNumber,
  TODAY,
  MONTH_START,
} from '../support/pg';

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

suite(
  'transfers HTTP surface — resolve/confirm/initiate, authz, anti-leak (e2e, needs Postgres + Redis)',
  () => {
    let app: INestApplication;
    let ds: any;
    let redis: any;
    let http: any;

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

    // ---- helpers --------------------------------------------------------------------------

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
    }

    async function mkCustomer(
      owner: string,
      overrides: Record<string, unknown> = {},
    ): Promise<any> {
      // Customer PII (name/phone/email) goes to the `customer` row; only true account fields
      // fall through to the account insert (else e.g. `phone` would hit `account`, which has no
      // such column). This also lets the PII-leak test set a known phone/email to prove they
      // never surface on the wire.
      const {
        name,
        phone,
        email,
        account_number: numberOverride,
        ...accountOverrides
      } = overrides as any;
      await insertCustomer(ds, owner, { name, phone, email });
      const accountNumber = (numberOverride as string) ?? localAccountNumber();
      const acc = await insertRow(ds, 'account', {
        kind: 'customer',
        owner_id: owner,
        currency: MXN,
        status: 'active',
        balance: 0,
        held: 0,
        account_number: accountNumber,
        spent_today_date: TODAY,
        spent_month_date: MONTH_START,
        ...accountOverrides,
      });
      createdAccountIds.push(acc.id);
      acc.account_number = acc.account_number ?? accountNumber;
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
      // Accounts FK owner_id → customer.id, so accounts drop BEFORE their customer parents.
      if (ids.length) await ds.query(`DELETE FROM account WHERE id = ANY($1)`, [ids]);
      if (owners.length) await ds.query(`DELETE FROM customer WHERE id = ANY($1)`, [owners]);
    }

    const asUser = (userId: string) => ({
      post: (path: string) =>
        request(http).post(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
      get: (path: string) =>
        request(http).get(path).set('X-User-Id', userId).set('X-Roles', 'customer'),
    });

    async function resolveDest(owner: string, accountNumber: string) {
      const res = await asUser(owner)
        .post('/api/transfers/resolve-destination')
        .send({ accountNumber });
      if (res.body?.confirmationToken) {
        trackedRedisKeys.push(`xfer:confirm:${owner}:${res.body.confirmationToken}`);
      }
      return res;
    }

    /** POST /api/transfers with an EXPLICIT body (for the zod / gate edge cases). */
    async function postTransferRaw(
      owner: string,
      body: Record<string, unknown>,
      opts: { key?: string; omitKey?: boolean } = {},
    ) {
      const req = asUser(owner).post('/api/transfers');
      if (!opts.omitKey) req.set('Idempotency-Key', opts.key ?? `key-${randomUUID()}`);
      return req.send(body);
    }

    /** The happy-path helper: resolve the destination (fresh token) then POST /api/transfers. */
    async function postTransfer(
      owner: string,
      sourceId: string,
      destAccount: any,
      amount: number,
      opts: { key?: string; confirmDuplicate?: boolean } = {},
    ) {
      const resolved = await resolveDest(owner, destAccount.account_number);
      const body: Record<string, unknown> = {
        sourceAccountId: sourceId,
        destinationAccountNumber: destAccount.account_number,
        amount: String(amount),
        currency: MXN,
        confirmationToken: resolved.body?.confirmationToken,
      };
      if (opts.confirmDuplicate !== undefined) body.confirmDuplicate = opts.confirmDuplicate;
      return postTransferRaw(owner, body, { key: opts.key });
    }

    async function mintOtp(
      owner: string,
    ): Promise<{ status: number; code?: string; ttlSeconds?: number; body: any }> {
      const res = await asUser(owner).post('/api/otp').send({});
      const code = res.body?.code ?? res.body?.otp?.code;
      if (code) {
        trackedRedisKeys.push(`otp:${owner}`);
        trackedRedisKeys.push(
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

    /** GET /api/pending-authorization returns `{ authorization: PendingAuthorizationDto | null }`. */
    async function getPendingAuth(owner: string) {
      return asUser(owner).get('/api/pending-authorization');
    }
    /** The single authorization object (or null) from the pending-authorization response body. */
    function authOf(body: any): any {
      return body?.authorization ?? null;
    }

    async function cancelTransfer(owner: string, transferId: string) {
      return asUser(owner).post(`/api/transfers/${transferId}/cancel`).send({});
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

    // ---- resolve-destination: masked name + token, anti-leak whitelist --------------------

    it('POST /api/transfers/resolve-destination → 200 {maskedName, currency, confirmationToken}; NO raw PII leaks', async () => {
      const caller = newOwner();
      const dst = await mkCustomer(newOwner(), {
        name: 'Juan Perez',
        phone: '5215555559999',
        email: 'juan.secret@example.test',
      });

      const res = await resolveDest(caller, dst.account_number);
      expect(res.status).toBe(200);

      // The DTO carries EXACTLY the three whitelisted fields — the holder's raw name/phone/email
      // (PII) must never cross the wire.
      expect(Object.keys(res.body).sort()).toEqual(
        ['confirmationToken', 'currency', 'maskedName'].sort(),
      );
      expect(res.body.maskedName).toBe('Jua** Per**');
      expect(res.body.currency).toBe(MXN);
      expect(typeof res.body.confirmationToken).toBe('string');
      expect(res.body.confirmationToken.length).toBeGreaterThan(0);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('Juan Perez');
      expect(serialized).not.toContain('5215555559999');
      expect(serialized).not.toContain('juan.secret@example.test');
      expect(serialized).not.toContain(dst.owner_id ?? dst.ownerId); // no owner sub
    });

    it('POST /api/transfers/resolve-destination with a non-10-digit accountNumber → 400 (zod)', async () => {
      const caller = newOwner();
      const bad = await asUser(caller)
        .post('/api/transfers/resolve-destination')
        .send({ accountNumber: '123' });
      expect(bad.status).toBe(400);
      expectErrorDto(bad.body, 'BAD_REQUEST');
    });

    // ---- full HTTP flow: resolve → initiate (PENDING) → otp → confirm (POSTED) ------------

    it('runs the full HTTP flow: resolve → POST /api/transfers 201 PENDING → POST /api/otp → confirm 200 POSTED', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { name: 'Ana Lopez', balance: 0 });

      const created = await postTransfer(owner, src.id, dst, 4000);
      expect(created.status).toBe(201);
      expect(statusOf(created.body)).toBe('PENDING');
      const transferId = idOf(created.body);

      const otp = await mintOtp(owner);
      expect(otp.status).toBe(201);
      expect(typeof otp.code).toBe('string');
      expect(typeof otp.ttlSeconds).toBe('number');
      expect(otp.ttlSeconds as number).toBeGreaterThan(0);

      const confirmed = await asUser(owner)
        .post(`/api/transfers/${transferId}/confirm`)
        .send({ code: otp.code });
      expect(confirmed.status).toBe(200);
      expect(statusOf(confirmed.body)).toBe('POSTED');

      // Movement observable in the DB: source debited, destination credited.
      const bal = await ds.query(`SELECT id, balance FROM account WHERE id = ANY($1)`, [
        [src.id, dst.id],
      ]);
      const byId = new Map<string, string>(bal.map((r: any) => [r.id, r.balance]));
      expect(byId.get(src.id)).toBe('6000');
      expect(byId.get(dst.id)).toBe('4000');
    });

    // ---- TransferDto over the wire: caller's own source id + destination number ----------

    it("the write Transfer DTO exposes the caller's OWN sourceAccountId + expiresAt, and NEVER destinationAccountNumber / raw credit UUID / initiatedBy / owner", async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      const res = await postTransfer(owner, src.id, dst, 4000);
      expect(res.status).toBe(201);

      const t = res.body?.transfer ?? res.body?.transaction ?? res.body;
      // Source is the caller's OWN account id (a UUID equal to the seeded source id) — mirrors
      // AccountDto.id, not a leak.
      expect(t.sourceAccountId).toBe(src.id);
      // Post review-fix: the write DTO is serialized FROM the Transaction entity, which carries only
      // the raw credit UUID — so it exposes NEITHER the human destination number NOR the raw UUID;
      // the destination number is a read-model concern (pending-authorization) only.
      expect('destinationAccountNumber' in t).toBe(false);
      // The time-box IS on the wire (expires_at → expiresAt), value present (string or null).
      expect('expiresAt' in t).toBe(true);

      const serialized = JSON.stringify(res.body);
      // The DESTINATION's raw UUID, the owner sub, and internal fields are NEVER on the wire; the
      // caller's own source id IS expected (asserted above), so it is not checked for absence.
      expect(serialized).not.toContain(dst.id);
      expect(serialized).not.toContain(owner);
      expect(serialized.toLowerCase()).not.toContain('initiatedby');
      expect(serialized.toLowerCase()).not.toContain('failurereason');
    });

    it('GET /api/pending-authorization returns { authorization: null } when the caller has none (never an array)', async () => {
      const owner = newOwner();
      await mkCustomer(owner, { balance: 10000 });

      const res = await getPendingAuth(owner);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false); // the endpoint is singular, not a list
      expect('authorization' in res.body).toBe(true);
      expect(authOf(res.body)).toBeNull();
    });

    it('GET /api/pending-authorization returns the SINGLE authorization (source id + destination number + masked name + expiresAt), no destination-UUID/owner/PII leak', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { name: 'Juan Perez', balance: 0 });

      const created = await postTransfer(owner, src.id, dst, 1000);
      const transferId = idOf(created.body);

      const res = await getPendingAuth(owner);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(false);
      const auth = authOf(res.body);
      expect(auth).toBeTruthy();
      expect(idOf(auth)).toBe(transferId);
      // Source is the caller's OWN account id (UUID equal to the seeded source id), not a leak.
      expect(auth.sourceAccountId).toBe(src.id);
      expect(auth.destinationAccountNumber).toBe(dst.account_number); // the read model DOES carry it
      expect(auth.destinationMaskedName).toBe('Jua** Per**'); // masked, never the raw name
      expect('expiresAt' in auth).toBe(true);

      const serialized = JSON.stringify(res.body);
      // Destination holder PII and the destination's raw UUID never cross the wire; the owner sub
      // is withheld. The caller's own source id IS expected (asserted above), so not checked here.
      expect(serialized).not.toContain('Juan Perez');
      expect(serialized).not.toContain(dst.id);
      expect(serialized).not.toContain(owner);
    });

    // ---- GET /api/accounts now carries accountNumber -------------------------------------

    it('GET /api/accounts includes accountNumber on each AccountDto (never the owner sub)', async () => {
      const owner = newOwner();
      const acc = await mkCustomer(owner, { balance: 500, account_number: '7778889990' });

      const res = await asUser(owner).get('/api/accounts');
      expect(res.status).toBe(200);
      const dto = res.body.accounts.find((a: any) => a.id === acc.id);
      expect(dto).toBeTruthy();
      expect(dto.accountNumber).toBe('7778889990');
      expect(JSON.stringify(res.body)).not.toContain(owner);
    });

    // ---- the confirmation gate at the HTTP edge ------------------------------------------

    it('POST /api/transfers with a well-formed but UNISSUED confirmationToken → 409 DESTINATION_NOT_CONFIRMED', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      // A token the caller never obtained from resolve: the gate must reject with the domain code.
      const res = await postTransferRaw(owner, {
        sourceAccountId: src.id,
        destinationAccountNumber: dst.account_number,
        amount: '1000',
        currency: MXN,
        confirmationToken: 'f'.repeat(48),
      });

      expect(res.status).toBe(409);
      expectErrorDto(res.body, 'DESTINATION_NOT_CONFIRMED');

      // No transfer was created for the caller.
      const n = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction" WHERE initiated_by = $1`,
        [owner],
      );
      expect(n[0].n).toBe(0);
    });

    it('POST /api/transfers rejects zod-invalid bodies with 400 (missing token, missing key, bad number/amount)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });
      const base = {
        sourceAccountId: src.id,
        destinationAccountNumber: dst.account_number,
        amount: '1000',
        currency: MXN,
        confirmationToken: 'f'.repeat(48),
      };

      // Missing Idempotency-Key header.
      const noKey = await postTransferRaw(owner, base, { omitKey: true });
      expect(noKey.status).toBe(400);
      expectErrorDto(noKey.body, 'BAD_REQUEST');

      // Missing confirmationToken (schema requires it) → 400, distinct from the 409 gate above.
      const noToken = {
        sourceAccountId: base.sourceAccountId,
        destinationAccountNumber: base.destinationAccountNumber,
        amount: base.amount,
        currency: base.currency,
      };
      const missingToken = await postTransferRaw(owner, noToken);
      expect(missingToken.status).toBe(400);

      // destinationAccountNumber not a 10-digit number.
      const badNumber = await postTransferRaw(owner, { ...base, destinationAccountNumber: '123' });
      expect(badNumber.status).toBe(400);

      // A source that is not a UUID.
      const badUuid = await postTransferRaw(owner, { ...base, sourceAccountId: 'not-a-uuid' });
      expect(badUuid.status).toBe(400);

      // A non-positive amount.
      const badAmount = await postTransferRaw(owner, { ...base, amount: '-500' });
      expect(badAmount.status).toBe(400);
    });

    // ---- object-level authorization (anti-IDOR) → 404, never 403/leak ---------------------

    it('POST /api/transfers debiting a source account owned by ANOTHER user → 404 (domain code, no leak)', async () => {
      const attacker = newOwner();
      const victim = newOwner();
      const victimAcc = await mkCustomer(victim, { balance: 10000 });
      const attackerAcc = await mkCustomer(attacker, { balance: 0 });

      // The attacker resolves their OWN account (allowed), then tries to pull funds OUT of the
      // victim's account into their own — the source ownership check must 404 before any movement.
      const resolved = await resolveDest(attacker, attackerAcc.account_number);
      const res = await postTransferRaw(attacker, {
        sourceAccountId: victimAcc.id,
        destinationAccountNumber: attackerAcc.account_number,
        amount: '5000',
        currency: MXN,
        confirmationToken: resolved.body?.confirmationToken,
      });

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

      const created = await postTransfer(ownerA, srcA.id, dst, 1000);
      const transferId = idOf(created.body);

      // B cannot see A's pending transfer — B's own single-pending read is null (B has none).
      const authB = await getPendingAuth(ownerB);
      expect(authB.status).toBe(200);
      expect(authOf(authB.body)).toBeNull();

      // B cannot confirm A's transfer — 404 for B, never 403.
      const otpB = await mintOtp(ownerB);
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

    it('confirm on an under-funded transfer → 422 with error.code INSUFFICIENT_FUNDS', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 1000 }); // available = 1000
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      const created = await postTransfer(owner, src.id, dst, 9000); // more than available
      expect(created.status).toBe(201); // accepted PENDING (no funds check at initiate)
      const transferId = idOf(created.body);

      const otp = await mintOtp(owner);
      const res = await asUser(owner)
        .post(`/api/transfers/${transferId}/confirm`)
        .send({ code: otp.code });

      expect(res.status).toBe(422);
      expectErrorDto(res.body, 'INSUFFICIENT_FUNDS');

      const after = await ds.query(`SELECT balance FROM account WHERE id = $1`, [src.id]);
      expect(after[0].balance).toBe('1000');
      // A confirm-time BUSINESS failure is now TERMINAL: the transfer is FAILED (reason + failed_at
      // stamped), not left PENDING; no money moved.
      const st = await ds.query(
        `SELECT status, failure_reason, failed_at FROM "transaction" WHERE id = $1`,
        [transferId],
      );
      expect(st[0].status).toBe('FAILED');
      expect((st[0].failure_reason ?? '').length).toBeGreaterThan(0);
      expect(st[0].failed_at).not.toBeNull();
    });

    it('confirm with a WRONG OTP → 401 with error.code INVALID_OTP', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      const created = await postTransfer(owner, src.id, dst, 1000);
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

      const first = await postTransfer(owner, src.id, dst, 1500);
      expect(first.status).toBe(201);

      const dup = await postTransfer(owner, src.id, dst, 1500); // different key, same fingerprint
      expect(dup.status).toBe(409);
      expectErrorDto(dup.body, 'SUSPECTED_DUPLICATE');

      const override = await postTransfer(owner, src.id, dst, 1500, { confirmDuplicate: true });
      expect(override.status).toBe(201); // an explicit repeat is allowed
      expect(idOf(override.body)).not.toBe(idOf(first.body));
    });

    // ---- cancel: POST /api/transfers/:id/cancel → 200 CANCELLED, then pending is null ----------

    it('POST /api/transfers/:id/cancel → 200 CANCELLED; then GET /api/pending-authorization is null', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      const created = await postTransfer(owner, src.id, dst, 2000);
      const transferId = idOf(created.body);

      const cancelled = await cancelTransfer(owner, transferId);
      expect(cancelled.status).toBe(200);
      expect(statusOf(cancelled.body)).toBe('CANCELLED');
      // The cancel write DTO obeys the same whitelist: expiresAt present, no destination number.
      const body = cancelled.body?.transfer ?? cancelled.body?.transaction ?? cancelled.body;
      expect('expiresAt' in body).toBe(true);
      expect('destinationAccountNumber' in body).toBe(false);

      // The caller now has no pending authorization, and the row is retained as CANCELLED.
      const auth = await getPendingAuth(owner);
      expect(authOf(auth.body)).toBeNull();
      const row = await ds.query(`SELECT status FROM "transaction" WHERE id = $1`, [transferId]);
      expect(row[0].status).toBe('CANCELLED');
    });

    it('POST /api/transfers/:id/cancel on a POSTED transfer → 409 TRANSFER_NOT_PENDING', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      const created = await postTransfer(owner, src.id, dst, 3000);
      const transferId = idOf(created.body);
      const otp = await mintOtp(owner);
      const confirmed = await asUser(owner)
        .post(`/api/transfers/${transferId}/confirm`)
        .send({ code: otp.code });
      expect(confirmed.status).toBe(200);

      const res = await cancelTransfer(owner, transferId);
      expect(res.status).toBe(409);
      expectErrorDto(res.body, 'TRANSFER_NOT_PENDING');
    });

    it("POST /api/transfers/:id/cancel on ANOTHER user's transfer → 404 (anti-IDOR, no leak)", async () => {
      const ownerA = newOwner();
      const ownerB = newOwner();
      const srcA = await mkCustomer(ownerA, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      const created = await postTransfer(ownerA, srcA.id, dst, 1000);
      const transferId = idOf(created.body);

      const res = await cancelTransfer(ownerB, transferId);
      expect(res.status).toBe(404);
      expectErrorDto(res.body);
      // A's transfer is untouched.
      const row = await ds.query(`SELECT status FROM "transaction" WHERE id = $1`, [transferId]);
      expect(row[0].status).toBe('PENDING');
    });

    // ---- confirm write DTO shape (POSTED) obeys the whitelist -----------------------------------

    it('the confirm (POSTED) write DTO carries expiresAt and never destinationAccountNumber / raw credit UUID', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      const created = await postTransfer(owner, src.id, dst, 4000);
      const transferId = idOf(created.body);
      const otp = await mintOtp(owner);
      const confirmed = await asUser(owner)
        .post(`/api/transfers/${transferId}/confirm`)
        .send({ code: otp.code });
      expect(confirmed.status).toBe(200);
      expect(statusOf(confirmed.body)).toBe('POSTED');

      const t = confirmed.body?.transfer ?? confirmed.body?.transaction ?? confirmed.body;
      expect('expiresAt' in t).toBe(true);
      expect('destinationAccountNumber' in t).toBe(false);
      expect(JSON.stringify(confirmed.body)).not.toContain(dst.id); // no raw credit UUID
    });

    // ---- expiry at the HTTP edge: an OVERDUE confirm → 410 TRANSFER_EXPIRED ---------------------

    it('POST /api/transfers/:id/confirm on an OVERDUE pending → 410 TRANSFER_EXPIRED (code NOT burned)', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 10000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      // Plant an overdue PENDING transfer for the caller (expires_at already in the past).
      const overdue = await insertTransaction(ds, {
        initiatedBy: owner,
        debitAccountId: src.id,
        creditAccountId: dst.id,
        amount: '3000',
        currency: MXN,
        expiresAt: new Date(Date.now() - 60_000),
      });

      const otp = await mintOtp(owner);
      const res = await asUser(owner)
        .post(`/api/transfers/${overdue.id}/confirm`)
        .send({ code: otp.code });
      expect(res.status).toBe(410);
      expectErrorDto(res.body, 'TRANSFER_EXPIRED');

      // The row transitioned to EXPIRED (retained), and no money moved.
      const row = await ds.query(`SELECT status FROM "transaction" WHERE id = $1`, [overdue.id]);
      expect(row[0].status).toBe('EXPIRED');
      const bal = await ds.query(`SELECT balance FROM account WHERE id = $1`, [src.id]);
      expect(bal[0].balance).toBe('10000');
    });

    // ---- single pending + auto-supersede visible across two initiates --------------------------

    it('a second POST /api/transfers auto-supersedes the first (→ CANCELLED); pending-authorization shows only the new one', async () => {
      const owner = newOwner();
      const src = await mkCustomer(owner, { balance: 20000 });
      const dst = await mkCustomer(newOwner(), { balance: 0 });

      const first = await postTransfer(owner, src.id, dst, 1000);
      expect(first.status).toBe(201);
      const firstId = idOf(first.body);

      // A DIFFERENT amount → different fingerprint (not a soft-duplicate) → a NEW pending.
      const second = await postTransfer(owner, src.id, dst, 2000);
      expect(second.status).toBe(201);
      const secondId = idOf(second.body);
      expect(secondId).not.toBe(firstId);

      // The single pending read shows ONLY the new one.
      const auth = await getPendingAuth(owner);
      expect(idOf(authOf(auth.body))).toBe(secondId);

      // The first is retained as CANCELLED (superseded).
      const rows = await ds.query(`SELECT id, status FROM "transaction" WHERE initiated_by = $1`, [
        owner,
      ]);
      const byId = new Map<string, string>(rows.map((r: any) => [r.id, r.status]));
      expect(byId.get(firstId)).toBe('CANCELLED');
      expect(byId.get(secondId)).toBe('PENDING');
    });

    // ---- ParseUUIDPipe: a malformed transfer id on confirm/cancel → 400 ------------------------

    it('POST /api/transfers/:id/confirm and /cancel with a malformed (non-UUID) id → 400 (ParseUUIDPipe)', async () => {
      const owner = newOwner();
      const badConfirm = await asUser(owner)
        .post('/api/transfers/not-a-uuid/confirm')
        .send({ code: '123456' });
      expect(badConfirm.status).toBe(400);

      const badCancel = await cancelTransfer(owner, 'not-a-uuid');
      expect(badCancel.status).toBe(400);
    });
  },
);
