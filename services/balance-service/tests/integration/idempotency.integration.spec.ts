/**
 * Spec 04 — Balance Service DOMAIN layer, STEP 3: idempotency + soft-duplicate suppression.
 * Written FROM the spec (Transfers → Idempotency + Duplicate-suppression) and the DoD
 * ("a replayed Idempotency-Key moves money once"), NOT from the implementor's code
 * (concurrent). The generic wrapper is resolved through the single harness seam
 * (getIdempotencyService / getDomainErrors), the same coordination point every other suite
 * imports through.
 *
 * Contract under test (spec-derived):
 *   IdempotencyService.execute(params, operation): Promise<{ transactionId, replayed }>, where
 *   params = { ownerId, key, fingerprintInput:{type,source,destination,amount,currency},
 *   confirmDuplicate? } and operation:(queryRunner)=>Promise<{ transactionId }> runs INSIDE
 *   the service's transaction. The claim + the operation commit TOGETHER (one tx).
 *   - Replay: same (ownerId,key) → operation NOT re-run; original transactionId, replayed:true.
 *   - Key reuse: same (ownerId,key), DIFFERENT fingerprint → IdempotencyKeyReuseError
 *     (code IDEMPOTENCY_KEY_REUSED).
 *   - Soft-duplicate: a DIFFERENT key with the SAME (ownerId,fingerprint) within 60s →
 *     SuspectedDuplicateError (code SUSPECTED_DUPLICATE) unless confirmDuplicate:true; outside
 *     the 60s window → allowed.
 *   - Atomicity: if operation throws, nothing persists (no key row, no tx) → the same key is
 *     retryable (a FAILED attempt re-runs; a SUCCEEDED one is once-only).
 *   - Concurrency: N concurrent execute with the SAME key → operation runs EXACTLY once; the
 *     others return the same transactionId (replayed) and none surface a raw DB error.
 *
 * The tripwire for "ran exactly once" is a REAL operation closure with an `invocations`
 * counter that inserts a minimal valid `transaction` row through the passed query runner —
 * no mocking of the logic under test.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a
 * false pass); beforeAll TCP-probes Postgres and boots the real AppModule. Committed rows are
 * cleaned up per-test, scoped by the random owner ids each test mints (so assertions are
 * per-owner and robust).
 *
 * To run:
 *   1. bring up the compose datastores (Postgres reachable to the test runner);
 *   2. BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=…] npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { getAppModule, getIdempotencyService, getDomainErrors, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import { insertIdempotencyKey } from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED idempotency suite: set BALANCE_INTEGRATION=1 (and point ' +
      'DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a reachable Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

const suite = ENABLED ? describe : describe.skip;

const REUSE_CODE = 'IDEMPOTENCY_KEY_REUSED';
const DUPLICATE_CODE = 'SUSPECTED_DUPLICATE';

interface FingerprintInput {
  type: string;
  source: string | null;
  destination: string | null;
  amount: string;
  currency: string;
}

suite(
  'IdempotencyService.execute — replay / key-reuse / soft-duplicate (integration, needs Postgres)',
  () => {
    let app: INestApplication;
    let ds: any;
    let idem: any;
    let domainErrors: ReturnType<typeof getDomainErrors>;

    // Each test mints random owner ids; cleanup removes their key + transaction rows.
    let trackedOwners: string[] = [];

    beforeAll(async () => {
      const reachable = await tcpProbe(DB_HOST, DB_PORT);
      if (!reachable) {
        throw new Error(
          `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ` +
            `${DB_HOST}:${DB_PORT}. Bring up the compose datastores (and publish/point ` +
            `DB_HOST/DB_PORT at them) or unset BALANCE_INTEGRATION.`,
        );
      }

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
      });
      for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

      const AppModule = getAppModule();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();

      try {
        const { DataSource } = require('typeorm');
        ds = app.get(DataSource);
      } catch {
        const { getDataSourceToken } = require('@nestjs/typeorm');
        ds = app.get(getDataSourceToken());
      }
      if (!ds)
        throw new Error('[integration] could not resolve the TypeORM DataSource from the app');

      const IdempotencyService = getIdempotencyService();
      idem = app.get(IdempotencyService, { strict: false });
      if (!idem || typeof idem.execute !== 'function') {
        throw new Error(
          '[integration] resolved the idempotency service but it has no `execute(params, operation)` ' +
            'method. If the entry point is named differently, update the seam ' +
            '(tests/support/harness.ts:getIdempotencyService) / coordinate the contract.',
        );
      }
      domainErrors = getDomainErrors();
    }, 60_000);

    afterEach(async () => {
      const owners = trackedOwners;
      trackedOwners = [];
      if (!owners.length) return;
      try {
        // idempotency_key FKs transaction_id → delete keys first, then the transactions.
        await ds.query(`DELETE FROM idempotency_key WHERE owner_id = ANY($1)`, [owners]);
        await ds.query(
          `DELETE FROM outbox_event WHERE transaction_id IN (SELECT id FROM "transaction" WHERE initiated_by = ANY($1))`,
          [owners],
        );
        await ds.query(
          `DELETE FROM ledger_entry WHERE transaction_id IN (SELECT id FROM "transaction" WHERE initiated_by = ANY($1))`,
          [owners],
        );
        await ds.query(`DELETE FROM "transaction" WHERE initiated_by = ANY($1)`, [owners]);
      } catch {
        /* best-effort; random owners keep re-runs safe even if one cleanup fails */
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

    function mkFI(overrides: Partial<FingerprintInput> = {}): FingerprintInput {
      return {
        type: 'internal',
        source: `acc-${randomUUID()}`,
        destination: `acc-${randomUUID()}`,
        amount: '1000',
        currency: 'MXN',
        ...overrides,
      };
    }

    function params(
      ownerId: string,
      key: string,
      fingerprintInput: FingerprintInput,
      confirmDuplicate?: boolean,
    ): any {
      const p: any = { ownerId, key, fingerprintInput };
      if (confirmDuplicate !== undefined) p.confirmDuplicate = confirmDuplicate;
      return p;
    }

    /** A REAL operation: inserts one minimal valid transaction row THROUGH the passed runner
     *  (so it shares the service's transaction) and counts its invocations — the "ran exactly
     *  once" tripwire. `qr.manager` (a QueryRunner's EntityManager) is used per the contract;
     *  falls back to `qr` if the service passes an EntityManager directly. */
    function makeOp(ownerId: string): {
      op: (qr: any) => Promise<{ transactionId: string }>;
      state: { invocations: number };
    } {
      const state = { invocations: 0 };
      const op = async (qr: any): Promise<{ transactionId: string }> => {
        state.invocations += 1;
        const runner = qr?.manager ?? qr;
        const rows = await runner.query(
          `INSERT INTO "transaction" (type, status, amount, currency, initiated_by)
         VALUES ('internal', 'POSTED', 1000, 'MXN', $1) RETURNING id`,
          [ownerId],
        );
        return { transactionId: rows[0].id };
      };
      return { op, state };
    }

    async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
      try {
        return { ok: true, value: await p };
      } catch (error) {
        return { ok: false, error };
      }
    }

    function expectDomainError(err: any, code: string, klass: any): void {
      expect(err).toBeDefined();
      if (klass) expect(err).toBeInstanceOf(klass);
      // The stable, machine-readable domain code (DomainError contract) — precise and decoupled
      // from any transport status.
      expect(err.code).toBe(code);
    }

    async function txCount(owner: string): Promise<number> {
      const r = await ds.query(
        `SELECT count(*)::int AS n FROM "transaction" WHERE initiated_by = $1`,
        [owner],
      );
      return r[0].n;
    }

    async function keyRow(owner: string, key: string): Promise<any | undefined> {
      const r = await ds.query(
        `SELECT status, transaction_id FROM idempotency_key WHERE owner_id = $1 AND key = $2`,
        [owner, key],
      );
      return r[0];
    }

    // ---- DoD: a replayed Idempotency-Key moves money ONCE ---------------------------------

    it('replays: same (ownerId,key) returns the original transactionId without re-running the operation', async () => {
      const owner = newOwner();
      const key = `key-${randomUUID()}`;
      const fi = mkFI();
      const { op, state } = makeOp(owner);

      const r1 = await idem.execute(params(owner, key, fi), op);
      expect(state.invocations).toBe(1);
      expect(r1.replayed).toBe(false);
      expect(typeof r1.transactionId).toBe('string');

      const r2 = await idem.execute(params(owner, key, fi), op);
      expect(state.invocations).toBe(1); // NOT re-run — the money moved exactly once
      expect(r2.replayed).toBe(true);
      expect(r2.transactionId).toBe(r1.transactionId);

      // Exactly one transaction and one completed key row bound to it.
      expect(await txCount(owner)).toBe(1);
      const row = await keyRow(owner, key);
      expect(row).toBeTruthy();
      expect(row.status).toBe('completed');
      expect(row.transaction_id).toBe(r1.transactionId);
    });

    // ---- Key reuse: same key, different fingerprint → reject, do not re-run ----------------

    it('rejects a reused key with a DIFFERENT fingerprint (IdempotencyKeyReuseError) and never re-runs', async () => {
      const owner = newOwner();
      const key = `key-${randomUUID()}`;
      const { op, state } = makeOp(owner);

      const r1 = await idem.execute(params(owner, key, mkFI({ amount: '1000' })), op);
      expect(state.invocations).toBe(1);
      expect(r1.replayed).toBe(false);

      // SAME key, DIFFERENT business tuple (amount) ⇒ different fingerprint ⇒ key reuse.
      const res = await capture(idem.execute(params(owner, key, mkFI({ amount: '2000' })), op));
      expect(res.ok).toBe(false);
      expectDomainError(res.error, REUSE_CODE, domainErrors.IdempotencyKeyReuseError);
      expect(state.invocations).toBe(1); // operation not re-run
      expect(await txCount(owner)).toBe(1); // no second money movement
    });

    // ---- Soft-duplicate: same fingerprint, different key, within 60s -----------------------

    it('suppresses a different key with the SAME fingerprint within 60s; confirmDuplicate overrides', async () => {
      const owner = newOwner();
      const fi = mkFI(); // one tuple reused across keys ⇒ identical fingerprint
      const { op, state } = makeOp(owner);

      const r1 = await idem.execute(params(owner, `k1-${randomUUID()}`, fi), op);
      expect(state.invocations).toBe(1);

      // A different key, same fingerprint, moments later → suspected duplicate (soft block).
      const dupKey = `k2-${randomUUID()}`;
      const res = await capture(idem.execute(params(owner, dupKey, fi), op));
      expect(res.ok).toBe(false);
      expectDomainError(res.error, DUPLICATE_CODE, domainErrors.SuspectedDuplicateError);
      expect(state.invocations).toBe(1); // operation not run for the suspected duplicate
      expect(await keyRow(owner, dupKey)).toBeUndefined(); // nothing persisted for the blocked key

      // confirmDuplicate:true lets an explicit repeat through (a repeated payment IS legitimate).
      const r3 = await idem.execute(params(owner, `k3-${randomUUID()}`, fi, true), op);
      expect(state.invocations).toBe(2);
      expect(r3.replayed).toBe(false);
      expect(r3.transactionId).not.toBe(r1.transactionId);
    });

    it('does NOT suppress a DIFFERENT fingerprint within the window (no false positive)', async () => {
      const owner = newOwner();
      const { op, state } = makeOp(owner);

      await idem.execute(params(owner, `ka-${randomUUID()}`, mkFI()), op);
      expect(state.invocations).toBe(1);

      // Different source/destination ⇒ different fingerprint ⇒ NOT a duplicate, even seconds later.
      const r = await idem.execute(params(owner, `kb-${randomUUID()}`, mkFI()), op);
      expect(state.invocations).toBe(2);
      expect(r.replayed).toBe(false);
    });

    it('window boundary: a same-fingerprint sibling OUTSIDE 60s is allowed, INSIDE 60s is suppressed', async () => {
      const fi = mkFI();

      // Learn the fingerprint the service computes for `fi` by reading it back from a real run
      // (the fingerprint hashes the tuple, NOT the owner — so it is the same for any owner).
      const scratch = newOwner();
      await idem.execute(params(scratch, `ks-${randomUUID()}`, fi), makeOp(scratch).op);
      const fp = (
        await ds.query(
          `SELECT request_fingerprint AS fp FROM idempotency_key WHERE owner_id = $1`,
          [scratch],
        )
      )[0].fp;
      expect(typeof fp).toBe('string');
      expect(fp.length).toBeGreaterThan(0);

      // OUTSIDE the window: the only same-fingerprint sibling is 120s old → a fresh request runs.
      const oOut = newOwner();
      await insertIdempotencyKey(ds, {
        owner_id: oOut,
        request_fingerprint: fp,
        created_at: new Date(Date.now() - 120_000).toISOString(),
      });
      const outOp = makeOp(oOut);
      const rOut = await idem.execute(params(oOut, `kout-${randomUUID()}`, fi), outOp.op);
      expect(outOp.state.invocations).toBe(1); // allowed → operation ran
      expect(rOut.replayed).toBe(false);

      // INSIDE the window: an otherwise-identical sibling that is only 10s old → suppressed.
      const oIn = newOwner();
      await insertIdempotencyKey(ds, {
        owner_id: oIn,
        request_fingerprint: fp,
        created_at: new Date(Date.now() - 10_000).toISOString(),
      });
      const inOp = makeOp(oIn);
      const res = await capture(idem.execute(params(oIn, `kin-${randomUUID()}`, fi), inOp.op));
      expect(res.ok).toBe(false);
      expectDomainError(res.error, DUPLICATE_CODE, domainErrors.SuspectedDuplicateError);
      expect(inOp.state.invocations).toBe(0); // operation never ran for the in-window duplicate
    });

    // ---- Atomicity: a throwing operation persists nothing; the key stays retryable ---------

    it('rolls back the key claim when the operation throws — nothing persists and the key is retryable', async () => {
      const owner = newOwner();
      const key = `key-${randomUUID()}`;
      const fi = mkFI();

      // The operation inserts a transaction row THEN throws: the rollback must undo BOTH the key
      // claim and that insert (they commit together or not at all).
      let boomInvocations = 0;
      const boom = async (qr: any): Promise<{ transactionId: string }> => {
        boomInvocations += 1;
        const runner = qr?.manager ?? qr;
        await runner.query(
          `INSERT INTO "transaction" (type, status, amount, currency, initiated_by)
         VALUES ('internal', 'POSTED', 1000, 'MXN', $1)`,
          [owner],
        );
        throw new Error('operation blew up after writing');
      };

      const res = await capture(idem.execute(params(owner, key, fi), boom));
      expect(res.ok).toBe(false);
      expect(boomInvocations).toBe(1); // it did run (and failed)

      // Nothing committed: no key row, no transaction row.
      expect(await keyRow(owner, key)).toBeUndefined();
      expect(await txCount(owner)).toBe(0);

      // Retry with the SAME key + a good operation → it RUNS (a failed attempt is retryable,
      // not falsely treated as a completed replay).
      const { op, state } = makeOp(owner);
      const retry = await idem.execute(params(owner, key, fi), op);
      expect(state.invocations).toBe(1);
      expect(retry.replayed).toBe(false);
      expect(await txCount(owner)).toBe(1);
    });

    // ---- Concurrency: N simultaneous execute with the same key → operation runs ONCE -------

    it('runs the operation EXACTLY once under N concurrent execute calls with the same key', async () => {
      const owner = newOwner();
      const key = `key-${randomUUID()}`;
      const fi = mkFI();
      const { op, state } = makeOp(owner);
      const N = 6;

      const results = await Promise.allSettled(
        Array.from({ length: N }, () => idem.execute(params(owner, key, fi), op)),
      );
      const fulfilled = results.filter(
        (r) => r.status === 'fulfilled',
      ) as PromiseFulfilledResult<any>[];
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

      // Exactly one execution; no call surfaces a raw error (the claim is an ON CONFLICT upsert,
      // not a caught unique-violation that leaks 23505 to a caller).
      expect(state.invocations).toBe(1);
      expect(rejected).toHaveLength(0);
      for (const r of rejected) {
        // (unreachable if the above holds) — but if any DID reject, prove it is not a raw dup.
        const code = r.reason?.code ?? r.reason?.driverError?.code;
        expect(code).not.toBe('23505');
      }

      // Every resolved call returns the SAME transaction; exactly one is the original, the rest
      // are replays.
      const ids = new Set(fulfilled.map((r) => r.value.transactionId));
      expect(ids.size).toBe(1);
      expect(fulfilled.filter((r) => r.value.replayed === false)).toHaveLength(1);
      expect(fulfilled.filter((r) => r.value.replayed === true)).toHaveLength(N - 1);

      // Exactly one transaction row and one key row persisted.
      expect(await txCount(owner)).toBe(1);
      const rows = await ds.query(
        `SELECT count(*)::int AS n FROM idempotency_key WHERE owner_id = $1 AND key = $2`,
        [owner, key],
      );
      expect(rows[0].n).toBe(1);
    }, 30_000);
  },
);
