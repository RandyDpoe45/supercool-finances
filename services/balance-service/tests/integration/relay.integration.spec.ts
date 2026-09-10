/**
 * Spec 04 — Balance Service, step 6: the OUTBOX RELAY WORKER against a REAL Postgres + Redis.
 * Written FROM the spec's "Outbox + relay worker" bullet + `docs/ARCHITECTURE.md §7` and the relay
 * Definition of Done ("Each money change emits exactly one outbox row in the same tx; the relay
 * publishes it — SKIP LOCKED verified across two instances"), NOT from the implementor's code.
 *
 * Why DB-backed against REAL Postgres + Redis (not mocked): the properties this worker exists to
 * provide are properties of REAL transactions + a REAL Redis stream —
 *   - `SELECT ... FOR UPDATE SKIP LOCKED` letting TWO instances drain the SAME table WITHOUT
 *     double-publishing (the keystone) is only meaningful across two independent connection pools
 *     racing one Postgres; a mock cannot prove it;
 *   - XADD-BEFORE-MARK (at-least-once) is observable only when a REAL publish can fail and leave the
 *     row genuinely unpublished, and when a redelivery re-XADDs the SAME event_id onto a real stream;
 *   - the stream ENTRY CONTRACT (`event_id`/`event_type`/`payload`) is what the analytics consumer
 *     reads, so it is asserted by reading the real stream.
 * So the suite drives the REAL DI'd `RelayService.drainOnce()` (resolved BY TOKEN through the app
 * graph) against the compose datastores, reading the stream back through the app's REDIS_CLIENT.
 *
 * TWO app instances (app1, app2) are booted against the SAME DB — two DataSources / two connection
 * pools — so the SKIP-LOCKED keystone runs two genuinely-concurrent drains via Promise.all.
 *
 * The background loop is DISABLED for the suite (env `RELAY_ENABLED=false`, via completeRawEnv) so
 * tests drive `drainOnce()` explicitly and a stray timer never drains rows out from under an
 * assertion; the "RELAY_ENABLED=false ⇒ no auto-run" proof relies on exactly this boot value.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a
 * false pass); beforeAll TCP-probes BOTH Postgres and Redis and fails loud if unreachable.
 *
 * Isolation on the SHARED datastores: every test seeds its own `transaction` + `outbox_event` rows
 * (tracked, cleaned per-test) and DELs the stream key `events:transactions` before AND after each
 * test (so stream assertions never see cross-test pollution). beforeEach also DRAINS any stray
 * pre-existing unpublished outbox rows to empty (then DELs the stream) so the "exactly N" stream
 * assertions are sound regardless of what earlier suites left behind.
 *
 * To run:
 *   1. bring up the compose datastores (Postgres + Redis reachable to the test runner);
 *   2. BALANCE_INTEGRATION=1 [DB_HOST=… REDIS_HOST=… …] npm test
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  getAppModule,
  getRelayServiceToken,
  getRedisClientToken,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import {
  insertTransaction,
  insertOutboxRow,
  getOutboxRow,
  countUnpublishedOutbox,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED relay suite: set BALANCE_INTEGRATION=1 (and point ' +
      'DB_* at a reachable Postgres and REDIS_* at a reachable Redis) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');

const suite = ENABLED ? describe : describe.skip;

const STREAM_KEY = 'events:transactions';
const MXN = 'MXN';

interface StreamEntry {
  streamId: string;
  fields: Record<string, string>;
}

suite(
  'RelayService.drainOnce — outbox → Redis stream (integration, needs Postgres + Redis)',
  () => {
    let app1: INestApplication;
    let app2: INestApplication;
    let ds1: any;
    let relay1: any;
    let relay2: any;
    let redis: any;

    // Every transaction + outbox row a test seeds; afterEach removes them (outbox FKs transaction).
    let trackedTxIds: string[] = [];
    let trackedOutboxIds: string[] = [];

    function envFor(): Record<string, unknown> {
      return completeRawEnv({
        DB_HOST,
        DB_PORT: String(DB_PORT),
        DB_NAME: process.env.DB_NAME || 'balance',
        DB_USER: process.env.DB_USER || 'balance_app',
        DB_PASSWORD: process.env.DB_PASSWORD || 'changeme-balance-local',
        REDIS_HOST,
        REDIS_PORT: String(REDIS_PORT),
        REDIS_PASSWORD: process.env.REDIS_PASSWORD || 'changeme-redis-local',
        INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-service-token',
        // Keep the background loop OFF (this is completeRawEnv's default; pinned explicitly here so a
        // future fixture edit cannot silently spin a timer that races these assertions).
        RELAY_ENABLED: 'false',
      });
    }

    async function bootApp(): Promise<INestApplication> {
      const env = envFor();
      for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
      const AppModule = getAppModule();
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication();
      await app.init(); // migrations already applied by app1 / prior suites → app2 is a no-op
      return app;
    }

    function dataSourceOf(app: INestApplication): any {
      try {
        const { DataSource } = require('typeorm');
        return app.get(DataSource);
      } catch {
        const { getDataSourceToken } = require('@nestjs/typeorm');
        return app.get(getDataSourceToken());
      }
    }

    function relayOf(app: INestApplication): any {
      const relay = app.get(getRelayServiceToken(), { strict: false });
      if (!relay || typeof relay.drainOnce !== 'function') {
        throw new Error(
          '[integration] resolved the relay service but it has no `drainOnce()` method. If the entry ' +
            'point is named differently, update the seam (tests/support/harness.ts:getRelayServiceToken) ' +
            '/ coordinate the contract.',
        );
      }
      return relay;
    }

    beforeAll(async () => {
      const dbReachable = await tcpProbe(DB_HOST, DB_PORT);
      if (!dbReachable) {
        throw new Error(
          `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ${DB_HOST}:${DB_PORT}. ` +
            `Bring up the compose datastores (and point DB_HOST/DB_PORT at them) or unset BALANCE_INTEGRATION.`,
        );
      }
      const redisReachable = await tcpProbe(REDIS_HOST, REDIS_PORT);
      if (!redisReachable) {
        throw new Error(
          `[integration] BALANCE_INTEGRATION=1 but Redis is not reachable at ${REDIS_HOST}:${REDIS_PORT}. ` +
            `The relay XADDs to it. Bring up the compose datastores (and point REDIS_HOST/REDIS_PORT at ` +
            `them) or unset BALANCE_INTEGRATION.`,
        );
      }

      // Boot SEQUENTIALLY (await each) so the two never race the CREATE TYPE/TABLE in MigrationExecutor.
      app1 = await bootApp();
      app2 = await bootApp();

      ds1 = dataSourceOf(app1);
      if (!ds1) throw new Error('[integration] could not resolve the TypeORM DataSource from app1');
      relay1 = relayOf(app1);
      relay2 = relayOf(app2);

      redis = app1.get(getRedisClientToken(), { strict: false });
      if (!redis || typeof redis.xrange !== 'function' || typeof redis.del !== 'function') {
        throw new Error(
          '[integration] could not resolve a usable ioredis client via REDIS_CLIENT for reading/resetting ' +
            'the stream (update tests/support/harness.ts:getRedisClientToken).',
        );
      }
    }, 120_000);

    beforeEach(async () => {
      // Clean slate: an empty stream AND no stray unpublished outbox rows (so "exactly N" holds).
      await redis.del(STREAM_KEY);
      await drainToEmpty(relay1);
      await redis.del(STREAM_KEY);
      trackedTxIds = [];
      trackedOutboxIds = [];
    });

    afterEach(async () => {
      const txIds = trackedTxIds;
      const outboxIds = trackedOutboxIds;
      trackedTxIds = [];
      trackedOutboxIds = [];
      try {
        await redis.del(STREAM_KEY);
        if (outboxIds.length) {
          await ds1.query(`DELETE FROM outbox_event WHERE id = ANY($1)`, [outboxIds]);
        }
        if (txIds.length) {
          // Any outbox rows still hanging off these txs (defensive) then the txs themselves.
          await ds1.query(`DELETE FROM outbox_event WHERE transaction_id = ANY($1)`, [txIds]);
          await ds1.query(`DELETE FROM "transaction" WHERE id = ANY($1)`, [txIds]);
        }
      } catch {
        /* best-effort */
      }
    });

    afterAll(async () => {
      if (app1) await app1.close();
      if (app2) await app2.close();
    });

    // ---- helpers --------------------------------------------------------------------------

    /** Drain repeatedly until a tick publishes nothing — clears any pre-existing unpublished rows so
     *  a test starts from an empty outbox. Bounded so a defect can never spin forever. */
    async function drainToEmpty(relay: any): Promise<void> {
      for (let i = 0; i < 1000; i++) {
        const n = await relay.drainOnce();
        if (!n || n <= 0) return;
      }
      throw new Error(
        '[integration] drainToEmpty did not converge — the relay keeps reporting work',
      );
    }

    async function seedTx(): Promise<string> {
      // A POSTED header (NOT PENDING → never trips the single-pending partial unique index); MXN is
      // migration-seeded so the currency FK is satisfied. Accounts are nullable (no legs needed).
      const tx = await insertTransaction(ds1, { status: 'POSTED', currency: MXN });
      trackedTxIds.push(tx.id);
      return tx.id;
    }

    async function seedOutbox(
      txId: string,
      opts: { payload?: Record<string, unknown>; eventType?: string; createdAt?: Date } = {},
    ): Promise<any> {
      const row = await insertOutboxRow(ds1, {
        transactionId: txId,
        eventType: opts.eventType,
        payload: opts.payload,
        createdAt: opts.createdAt,
      });
      trackedOutboxIds.push(row.id);
      return row;
    }

    /** Read the whole stream oldest-first (xrange is ascending by stream id = insertion order). */
    async function readStream(): Promise<StreamEntry[]> {
      const raw: Array<[string, string[]]> = await redis.xrange(STREAM_KEY, '-', '+');
      return raw.map(([streamId, flat]) => {
        const fields: Record<string, string> = {};
        for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
        return { streamId, fields };
      });
    }

    async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
      try {
        return { ok: true, value: await p };
      } catch (error) {
        return { ok: false, error };
      }
    }

    /** Resolve `p` if it settles within `ms`, else REJECT with `msg`. Turns "the drain blocked on a
     *  held lock" (a plain-FOR-UPDATE regression) into a fast, deterministic failure instead of a
     *  hang. The timer is cleared when `p` settles so a passing case leaves no dangling handle. */
    function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
      let timer: NodeJS.Timeout;
      const timeout = new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms);
      });
      return Promise.race([
        p.then(
          (v) => {
            clearTimeout(timer);
            return v;
          },
          (e) => {
            clearTimeout(timer);
            throw e;
          },
        ),
        timeout,
      ]);
    }

    // ---- 1) End-to-end drain: publish the row, mark it, don't re-drain -------------------------

    it('drains one unpublished row to events:transactions (event_id/event_type/payload), marks it published, and does not re-drain it', async () => {
      const txId = await seedTx();
      const payload = { txId, type: 'internal', currency: MXN, amount: '1500', seq: 1 };
      const row = await seedOutbox(txId, { payload, eventType: 'transaction.posted' });

      const n = await relay1.drainOnce();
      expect(n).toBe(1); // exactly the one row we seeded (clean slate)

      const entries = await readStream();
      expect(entries).toHaveLength(1);
      const e = entries[0].fields;
      // The stream ENTRY CONTRACT the analytics consumer reads.
      expect(e.event_id).toBe(row.id); // event_id IS the outbox row id (dedup key)
      expect(e.event_type).toBe('transaction.posted');
      expect(JSON.parse(e.payload)).toEqual(payload); // payload JSON round-trips to the reducer's object

      // The row is now marked published (mark step ran, in the same tick).
      const after = await getOutboxRow(ds1, row.id);
      expect(after?.published_at).not.toBeNull();

      // A published row is NOT re-drained: the next tick finds nothing and adds no stream entry.
      const n2 = await relay1.drainOnce();
      expect(n2).toBe(0);
      expect(await readStream()).toHaveLength(1);
    });

    // ---- 2a) KEYSTONE (safety): two concurrent instances NEVER double-publish -------------------

    it('two concurrent instances draining the SAME table claim each row EXACTLY once: counts sum to N, all rows marked, stream has N distinct event_ids — no double-publish', async () => {
      const N = 16;
      // Repeat a few rounds to widen the window for a missing-lock double-publish to manifest.
      for (let round = 0; round < 3; round++) {
        await redis.del(STREAM_KEY);
        const txId = await seedTx();
        const ids: string[] = [];
        for (let i = 0; i < N; i++) {
          const r = await seedOutbox(txId, { payload: { round, seq: i } });
          ids.push(r.id);
        }

        // TWO genuinely-concurrent drains, one per app (per DataSource / connection pool).
        const settled = await Promise.allSettled([relay1.drainOnce(), relay2.drainOnce()]);

        // Neither instance errored (no deadlock / leaked serialization failure).
        for (const s of settled) {
          expect(s.status).toBe('fulfilled');
        }
        const counts = (settled as PromiseFulfilledResult<number>[]).map((s) => s.value);
        // Every row published EXACTLY once between the two: the counts partition N (no row double-
        // published, none dropped). This proves the no-double-publish SAFETY invariant. NOTE: it does
        // NOT by itself DISCRIMINATE `FOR UPDATE SKIP LOCKED` from a plain blocking `FOR UPDATE` — a
        // blocking lock would ALSO yield sum==N (instance 2 waits, then under READ COMMITTED re-reads
        // and sees the rows already published → returns 0). The non-blocking property that IS unique to
        // SKIP LOCKED is isolated by the dedicated liveness test (2b) below.
        expect(counts[0] + counts[1]).toBe(N);

        // Every seeded row ends published (all claimed + marked).
        expect(await countUnpublishedOutbox(ds1, ids)).toBe(0);

        // The stream has EXACTLY N entries with N DISTINCT event_ids == the N seeded ids: proof there
        // was NO double-publish (a duplicate would be an extra entry / a repeated event_id).
        const entries = await readStream();
        expect(entries).toHaveLength(N);
        const eventIds = entries.map((e) => e.fields.event_id);
        expect(new Set(eventIds).size).toBe(N);
        expect(new Set(eventIds)).toEqual(new Set(ids));

        await redis.del(STREAM_KEY);
      }
    }, 60_000);

    // ---- 2b) KEYSTONE (liveness): SKIP LOCKED is NON-BLOCKING — skip locked rows, drain the rest --
    // This is the test that actually PROVES `FOR UPDATE SKIP LOCKED` (DoD "SKIP LOCKED verified"): a
    // second open transaction holds a lock on the oldest k unpublished rows, and a drain on another
    // connection must skip PAST them and publish the remaining N−k PROMPTLY rather than block. A
    // regression to a plain blocking `FOR UPDATE` would WAIT on the held lock (the holder is not
    // released until after the drain), so the drain never returns → the withTimeout guard rejects and
    // this test fails (discriminating SKIP LOCKED from plain FOR UPDATE), instead of the sum==N pass
    // that 2a would still give.

    it('skips rows locked by another OPEN transaction and drains the rest promptly (SKIP LOCKED is non-blocking)', async () => {
      const N = 6;
      const k = 2; // the oldest k rows are held under an uncommitted lock
      const txId = await seedTx();
      const ids: string[] = [];
      const base = Date.now();
      for (let i = 0; i < N; i++) {
        // created_at ASC == index order (i=0 oldest); the relay drains oldest-first, so ids[0..k-1]
        // are exactly the rows the holder locks below.
        const r = await seedOutbox(txId, {
          payload: { seq: i },
          createdAt: new Date(base - (N - i) * 1000),
        });
        ids.push(r.id);
      }

      // Hold a lock on the oldest k rows in a SEPARATE, uncommitted transaction (app1's pool), using
      // the SAME claim shape the relay uses. Keep it OPEN across the drain below.
      const holder = ds1.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      // The still-pending drain (only lands here if a regression makes it block); awaited in `finally`
      // AFTER the holder releases, so it never writes after the test finishes.
      let drainPromise: Promise<number> | undefined;
      try {
        const locked: Array<{ id: string }> = await holder.query(
          `SELECT id FROM outbox_event
             WHERE published_at IS NULL
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $1`,
          [k],
        );
        expect(locked).toHaveLength(k);
        const lockedIds = locked.map((r) => r.id);
        expect(new Set(lockedIds)).toEqual(new Set(ids.slice(0, k))); // the oldest k

        // A DIFFERENT instance (app2 pool) drains. SKIP LOCKED ⇒ it steps over the held k and returns
        // the remaining N−k PROMPTLY. A plain blocking FOR UPDATE would hang here (holder still open).
        const dp: Promise<number> = relay2.drainOnce();
        drainPromise = dp;
        const published = await withTimeout(
          dp,
          5_000,
          'drainOnce blocked on the rows locked by the open holder tx — SKIP LOCKED not in effect (a ' +
            'plain blocking FOR UPDATE would wait for the holder to release)',
        );
        expect(published).toBe(N - k);

        // The held k stayed UNPUBLISHED (skipped, not claimed); the other N−k are published + on stream.
        expect(await countUnpublishedOutbox(ds1, lockedIds)).toBe(k);
        expect(await countUnpublishedOutbox(ds1, ids.slice(k))).toBe(0);

        const entries = await readStream();
        expect(entries).toHaveLength(N - k);
        expect(new Set(entries.map((e) => e.fields.event_id))).toEqual(new Set(ids.slice(k)));
      } finally {
        // Release the held lock so afterEach's DELETE (and any still-pending blocked drain) proceed.
        try {
          await holder.rollbackTransaction();
        } catch {
          /* already rolled back / aborted */
        }
        await holder.release();
        // In the regression (timeout) path the drain was still blocked; now that the lock is freed it
        // completes — await it so it cannot write to the DB/stream after the test ends.
        if (drainPromise) {
          try {
            await drainPromise;
          } catch {
            /* the drain's own failure is not what this test asserts */
          }
        }
      }
    }, 20_000);

    // ---- 3) At-least-once: a FAILED publish tick neither loses nor marks (XADD-before-mark) -----

    it('a tick whose XADD fails leaves the row UNPUBLISHED (not marked); a later working tick then publishes it exactly once', async () => {
      const txId = await seedTx();
      const payload = { txId, marker: 'at-least-once' };
      const row = await seedOutbox(txId, { payload });

      // Force the tick's XADD to fail against REAL Redis WITHOUT stubbing the DI'd client: make the
      // stream key a STRING, so XADD raises WRONGTYPE. If the relay marked BEFORE the XADD, the row
      // would be lost here; XADD-before-mark means the failed tick marks nothing.
      await redis.set(STREAM_KEY, 'not-a-stream');

      const res = await capture(relay1.drainOnce());
      // The spec allows either surfacing the error or reporting 0 published — but NEVER a success count.
      expect(res.ok === false || res.value === 0).toBe(true);

      // The keystone observable: the row SURVIVED the failed tick unmarked (nothing lost, not marked).
      const afterFail = await getOutboxRow(ds1, row.id);
      expect(afterFail?.published_at).toBeNull();

      // Recover: clear the bad key, drain again → the row publishes exactly once now.
      await redis.del(STREAM_KEY);
      const n = await relay1.drainOnce();
      expect(n).toBeGreaterThanOrEqual(1);

      const entries = await readStream();
      expect(entries).toHaveLength(1);
      expect(entries[0].fields.event_id).toBe(row.id);
      const afterOk = await getOutboxRow(ds1, row.id);
      expect(afterOk?.published_at).not.toBeNull();
    });

    // ---- 4) Duplicate carries the SAME event_id (stable dedup key) ------------------------------

    it('a redelivered row (published_at reset to NULL) is re-published with the SAME event_id, so the consumer can dedup', async () => {
      const txId = await seedTx();
      const row = await seedOutbox(txId, { payload: { txId, dup: true } });

      // First publish.
      expect(await relay1.drainOnce()).toBe(1);
      let entries = await readStream();
      expect(entries).toHaveLength(1);
      expect(entries[0].fields.event_id).toBe(row.id);

      // Simulate a redelivery (a crash after XADD, before/without the mark committing): the row is
      // unpublished again and gets drained a second time.
      await ds1.query(`UPDATE outbox_event SET published_at = NULL WHERE id = $1`, [row.id]);
      expect(await relay1.drainOnce()).toBe(1);

      // BOTH stream entries carry the SAME event_id — the analytics consumer upserts on it (idempotent).
      entries = await readStream();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.fields.event_id)).toEqual([row.id, row.id]);
    });

    // ---- 5) Ordering: rows drain oldest-first (created_at) --------------------------------------

    it('publishes rows OLDEST-first by created_at (the stream preserves XADD order), regardless of insertion order', async () => {
      const txId = await seedTx();
      const now = Date.now();
      // Seed NEWEST-first so DB insertion order is the REVERSE of created_at order — only a correct
      // `ORDER BY created_at` can produce the oldest-first stream order asserted below.
      const r3 = await seedOutbox(txId, { payload: { seq: 3 }, createdAt: new Date(now - 1000) });
      const r2 = await seedOutbox(txId, { payload: { seq: 2 }, createdAt: new Date(now - 2000) });
      const r1 = await seedOutbox(txId, { payload: { seq: 1 }, createdAt: new Date(now - 3000) });

      expect(await relay1.drainOnce()).toBe(3);

      const entries = await readStream();
      expect(entries).toHaveLength(3);
      // Oldest → newest: r1 (now-3000), r2 (now-2000), r3 (now-1000).
      expect(entries.map((e) => e.fields.event_id)).toEqual([r1.id, r2.id, r3.id]);
      expect(entries.map((e) => JSON.parse(e.fields.payload).seq)).toEqual([1, 2, 3]);
    });

    // ---- 6) RELAY_ENABLED=false ⇒ no background auto-run ----------------------------------------

    it('does NOT auto-drain when RELAY_ENABLED=false: an unpublished row stays unpublished over a wait, then an explicit drainOnce publishes it', async () => {
      const txId = await seedTx();
      const row = await seedOutbox(txId, { payload: { txId, autoRun: false } });

      // Wait well past several poll intervals (default 500ms). If the background loop were running, it
      // would have drained the row by now.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const stillPending = await getOutboxRow(ds1, row.id);
      expect(stillPending?.published_at).toBeNull(); // NOT auto-drained
      expect(await readStream()).toHaveLength(0); // NOT auto-published

      // The row IS drainable — an explicit tick publishes it (so the "stayed unpublished" above was
      // due to the disabled loop, not an un-drainable row).
      expect(await relay1.drainOnce()).toBeGreaterThanOrEqual(1);
      const entries = await readStream();
      expect(entries).toHaveLength(1);
      expect(entries[0].fields.event_id).toBe(row.id);
      const after = await getOutboxRow(ds1, row.id);
      expect(after?.published_at).not.toBeNull();
    }, 15_000);
  },
);
