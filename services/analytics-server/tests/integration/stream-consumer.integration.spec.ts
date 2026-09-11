/**
 * Spec 05, step A2 — the STREAM CONSUMER, end to end over a live Redis + Mongo.
 * Written from the CONTRACT OF RECORD (specs/DATA-MODEL.md Part 2 "Consumer
 * idempotency & ordering" + the wire event shape) and the spec-05 DoD, NOT from the
 * implementor's code. Every test is built to FAIL on a real defect.
 *
 * DoD proofs anchored here:
 *   - "Publishing an event on `events:transactions` results in EXACTLY ONE Mongo
 *      document, even when the event is redelivered." (proof 1 + money-exactness proof 4)
 *   - "A consumer restart re-processes only un-acked entries (no loss, no dupes)."
 *      (proof 2 — an entry stuck in the consumer PEL is reclaimed + acked; an
 *      already-acked entry is never reprocessed into a duplicate)
 * Plus the money-safe consumer choices: FAILED events project to empty-legs docs
 * (proof 3), group creation is idempotent (proof 5), and a malformed entry does not
 * poison the batch nor get silently dropped (proof 6).
 *
 * Genuinely Redis+Mongo-dependent -> honest-SKIP (mirrors the other integration
 * suites): OPT-IN via ANALYTICS_INTEGRATION=1 (a default `npm test` reports SKIPPED,
 * never a false pass); when opted in it TCP-probes BOTH datastores and fails LOUDLY
 * if either is unreachable. It boots the REAL AppModule (consumer loop DISABLED via
 * ANALYTICS_CONSUMER_ENABLED=false) and drives `consumeOnce()` deterministically —
 * never the live setTimeout loop.
 *
 * Isolation: the stream key `events:transactions` is a fixed contract literal, so this
 * suite fully resets it (`DEL`) before EVERY test and re-creates the `analytics` group
 * per test; Mongo docs are tracked by `_id` and deleted in `afterEach`. Only this suite
 * touches that stream, so a `DEL` between tests is safe and keeps the suite re-runnable.
 *
 * To run:
 *   1. bring up the compose datastores (redis + mongo reachable to the runner);
 *   2. export the analytics MONGO_* / REDIS_* env (or rely on the defaults below);
 *   3. ANALYTICS_INTEGRATION=1 npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';

import {
  getAppModule,
  getRedisClientToken,
  getStreamConsumerToken,
  getTransactionsRepositoryToken,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';

const ENABLED = process.env.ANALYTICS_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED stream-consumer suite: set ANALYTICS_INTEGRATION=1 (and point ' +
      'REDIS_HOST/REDIS_PORT + MONGO_HOST/MONGO_PORT/... at reachable datastores) to run it.',
  );
}

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1';
const MONGO_PORT = Number(process.env.MONGO_PORT || '27017');

// Contract-fixed transport coordinates (specs/DATA-MODEL.md Part 2 + task): the relay
// XADDs to this stream; the consumer group + consumer name are spec-fixed.
const STREAM = 'events:transactions';
const GROUP = 'analytics';
const CONSUMER = 'analytics-consumer';
const COLLECTION = 'transactions';

// 2^53 + 1 (money-exactness) and int64 max (top of range).
const HUGE = 9_007_199_254_740_993n;

const suite = ENABLED ? describe : describe.skip;

interface StreamConsumer {
  ensureGroup(): Promise<void>;
  consumeOnce(options?: { claimMinIdleMs?: number }): Promise<number>;
}

interface WireEvent {
  eventId: string;
  eventType: 'transaction.posted' | 'transaction.failed';
  transactionId: string;
  owner: string;
  payloadJson: string;
}

/** Build a valid POSTED wire event (camelCase, money as int64 STRINGS). */
function buildPosted(opts: { amount?: bigint } = {}): WireEvent {
  const eventId = randomUUID();
  const transactionId = randomUUID();
  const owner = `sub-${randomUUID()}`;
  const amount = opts.amount ?? 50_000n;
  const payload = {
    schemaVersion: 1,
    occurredAt: '2026-09-08T12:00:00.000Z',
    transaction: {
      id: transactionId,
      type: 'external_outbound',
      status: 'POSTED',
      amount: amount.toString(),
      currency: 'MXN',
      initiatedBy: owner,
      reversesTransactionId: null,
      payee: { id: randomUUID(), displayName: 'ACME', rail: 'rail-outbound' },
      createdAt: '2026-09-08T12:00:00.000Z',
      postedAt: '2026-09-08T12:00:01.000Z',
      failureReason: null,
    },
    legs: [
      {
        accountId: randomUUID(),
        ownerId: owner,
        accountKind: 'customer',
        systemKey: null,
        delta: (-amount).toString(),
        balanceAfter: '150000',
        currency: 'MXN',
      },
      {
        accountId: randomUUID(),
        ownerId: null,
        accountKind: 'system',
        systemKey: 'clearing:rail-outbound',
        delta: amount.toString(),
        balanceAfter: '900000',
        currency: 'MXN',
      },
    ],
  };
  return {
    eventId,
    eventType: 'transaction.posted',
    transactionId,
    owner,
    payloadJson: JSON.stringify(payload),
  };
}

/** Build a valid FAILED wire event — status FAILED, EMPTY legs, reason set. */
function buildFailed(reason: string): WireEvent {
  const eventId = randomUUID();
  const transactionId = randomUUID();
  const owner = `sub-${randomUUID()}`;
  const payload = {
    schemaVersion: 1,
    occurredAt: '2026-09-08T12:00:03.000Z',
    transaction: {
      id: transactionId,
      type: 'external_outbound',
      status: 'FAILED',
      amount: '50000',
      currency: 'MXN',
      initiatedBy: owner,
      reversesTransactionId: null,
      payee: { id: randomUUID(), displayName: 'ACME', rail: 'rail-outbound' },
      createdAt: '2026-09-08T12:00:00.000Z',
      postedAt: null,
      failureReason: reason,
    },
    legs: [],
  };
  return {
    eventId,
    eventType: 'transaction.failed',
    transactionId,
    owner,
    payloadJson: JSON.stringify(payload),
  };
}

suite('stream consumer (integration, needs Redis + Mongo)', () => {
  let app: INestApplication;
  let consumer: StreamConsumer;
  let redis: any;
  let repo: any;
  let connection: any;
  const created: string[] = [];

  /** XADD a wire event as the relay would (event_id / event_type / payload fields). */
  async function xadd(
    ev: WireEvent | { eventId: string; eventType: string; payloadJson: string },
  ): Promise<string> {
    created.push(ev.eventId);
    return redis.call(
      'XADD',
      STREAM,
      '*',
      'event_id',
      ev.eventId,
      'event_type',
      ev.eventType,
      'payload',
      ev.payloadJson,
    );
  }

  /** Group-pending count for the whole `analytics` group (summary form of XPENDING). */
  async function pendingCount(): Promise<number> {
    const res: any = await redis.call('XPENDING', STREAM, GROUP);
    return Number(res?.[0] ?? 0);
  }

  /** Create the consumer group at `$` on a fresh stream (MKSTREAM); BUSYGROUP is a no-op. */
  async function createGroupRaw(): Promise<void> {
    try {
      await redis.call('XGROUP', 'CREATE', STREAM, GROUP, '$', 'MKSTREAM');
    } catch (e: any) {
      if (!String(e?.message).includes('BUSYGROUP')) throw e;
    }
  }

  async function docCount(id: string): Promise<number> {
    return connection.db.collection(COLLECTION).countDocuments({ _id: id });
  }

  beforeAll(async () => {
    const [redisUp, mongoUp] = await Promise.all([
      tcpProbe(REDIS_HOST, REDIS_PORT),
      tcpProbe(MONGO_HOST, MONGO_PORT),
    ]);
    if (!redisUp || !mongoUp) {
      throw new Error(
        `[integration] ANALYTICS_INTEGRATION=1 but a datastore is unreachable ` +
          `(redis ${REDIS_HOST}:${REDIS_PORT} up=${redisUp}, mongo ${MONGO_HOST}:${MONGO_PORT} up=${mongoUp}). ` +
          `Bring up the compose datastores or unset ANALYTICS_INTEGRATION.`,
      );
    }

    const env = completeRawEnv({
      REDIS_HOST,
      REDIS_PORT: String(REDIS_PORT),
      REDIS_PASSWORD: process.env.REDIS_PASSWORD || 'changeme-redis-local',
      MONGO_HOST,
      MONGO_PORT: String(MONGO_PORT),
      MONGO_DB: process.env.MONGO_DB || 'analytics',
      MONGO_USER: process.env.MONGO_USER || 'analytics_app',
      MONGO_PASSWORD: process.env.MONGO_PASSWORD || 'changeme-analytics-local',
      MONGO_AUTH_SOURCE: process.env.MONGO_AUTH_SOURCE || 'analytics',
      // Keep the live poll loop OFF — we drive consumeOnce() deterministically.
      ANALYTICS_CONSUMER_ENABLED: 'false',
    });
    for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

    const AppModule = getAppModule();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // establishes real Mongo + Redis connections; loop disabled

    consumer = app.get(getStreamConsumerToken(), { strict: false });
    redis = app.get(getRedisClientToken(), { strict: false });
    repo = app.get(getTransactionsRepositoryToken(), { strict: false });
    connection = app.get(getConnectionToken(), { strict: false });
  }, 60_000);

  beforeEach(async () => {
    // Pristine transport before every test (fixed literal stream): DEL wipes the
    // stream AND its consumer groups, so each test re-creates `analytics` cleanly.
    try {
      await redis.call('DEL', STREAM);
    } catch {
      /* stream may not exist yet — fine */
    }
  });

  afterEach(async () => {
    if (connection?.db && created.length) {
      await connection.db.collection(COLLECTION).deleteMany({ _id: { $in: created.splice(0) } });
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('proof 1+4: publishing a posted event yields EXACTLY ONE fully-projected doc (money exact > 2^53), acked; redelivery stays at one', async () => {
    await createGroupRaw();
    const ev = buildPosted({ amount: HUGE });
    await xadd(ev);

    const n = await consumer.consumeOnce();
    expect(n).toBe(1); // one entry processed

    const coll = connection.db.collection(COLLECTION);
    expect(await docCount(ev.eventId)).toBe(1);

    // Fully projected + money exact past 2^53 (proof 4).
    const doc = await repo.findById(ev.eventId);
    expect(doc).not.toBeNull();
    expect(doc.transactionId).toBe(ev.transactionId);
    expect(doc.eventType).toBe('transaction.posted');
    expect(doc.status).toBe('POSTED');
    expect(typeof doc.amount).toBe('bigint');
    expect(doc.amount).toBe(HUGE);
    for (const leg of doc.legs) {
      expect(typeof leg.delta).toBe('bigint');
      expect(typeof leg.balanceAfter).toBe('bigint');
    }
    const deltas = doc.legs.map((l: any) => l.delta);
    expect(deltas).toContain(HUGE);
    expect(deltas).toContain(-HUGE);
    expect(doc.legs.reduce((a: bigint, l: any) => a + l.delta, 0n)).toBe(0n); // sum-zero
    expect(new Set(doc.owners)).toEqual(new Set([ev.owner]));
    expect(doc.occurredAt instanceof Date).toBe(true);

    // Stored BSON type is `long`, never a float64 `double` — an integer > 2^53 could
    // not sit in a double slot without loss, so a `double` here would be the smoking gun.
    expect(await coll.countDocuments({ _id: ev.eventId, amount: { $type: 'long' } })).toBe(1);
    expect(await coll.countDocuments({ _id: ev.eventId, amount: { $type: 'double' } })).toBe(0);
    expect(await coll.countDocuments({ _id: ev.eventId, 'legs.delta': { $type: 'long' } })).toBe(1);
    expect(await coll.countDocuments({ _id: ev.eventId, 'legs.delta': { $type: 'double' } })).toBe(
      0,
    );

    // Write-then-ack: nothing left pending for the group.
    expect(await pendingCount()).toBe(0);

    // Redelivery: the SAME event_id arrives again as a NEW stream entry (at-least-once).
    await xadd(ev);
    await consumer.consumeOnce();
    expect(await docCount(ev.eventId)).toBe(1); // STILL exactly one (idempotent upsert)
    expect(await coll.countDocuments({ transactionId: ev.transactionId })).toBe(1);
    expect(await pendingCount()).toBe(0);
  }, 60_000);

  it('proof 2: a restart reclaims only UN-ACKED entries — no loss, no dupes', async () => {
    await createGroupRaw();
    const ev = buildPosted();
    await xadd(ev);

    // Simulate the consumer reading the entry then crashing BEFORE upsert+ack: a raw
    // XREADGROUP as `analytics-consumer` moves it into the PEL without acking. The
    // group's last-delivered-id advances past it, so a plain `>` read will NOT see it
    // again — only the reclaim path (XAUTOCLAIM/XPENDING) can recover it.
    const delivered = await redis.call(
      'XREADGROUP',
      'GROUP',
      GROUP,
      CONSUMER,
      'COUNT',
      '10',
      'STREAMS',
      STREAM,
      '>',
    );
    expect(delivered).not.toBeNull();
    expect(await docCount(ev.eventId)).toBe(0); // no upsert happened on the raw read
    expect(await pendingCount()).toBe(1); // stuck in the PEL

    // Restart: reclaim with min-idle 0 (deterministic) -> upsert + ack.
    await consumer.consumeOnce({ claimMinIdleMs: 0 });
    expect(await docCount(ev.eventId)).toBe(1); // no loss
    expect(await pendingCount()).toBe(0); // reclaimed entry is now acked

    // An already-processed+acked entry is NOT reprocessed into a duplicate.
    await consumer.consumeOnce({ claimMinIdleMs: 0 });
    expect(await docCount(ev.eventId)).toBe(1); // no dupes
    expect(await pendingCount()).toBe(0);
  }, 60_000);

  it('proof 3: a transaction.failed event projects to a FAILED doc — empty legs, owners empty, failureReason persisted, acked', async () => {
    await createGroupRaw();
    const ev = buildFailed('INSUFFICIENT_FUNDS');
    await xadd(ev);

    await consumer.consumeOnce();

    // Assert on the STORED document directly (proves persistence of the A2 field).
    const raw: any = await connection.db.collection(COLLECTION).findOne({ _id: ev.eventId });
    expect(raw).not.toBeNull();
    expect(raw.status).toBe('FAILED');
    expect(raw.eventType).toBe('transaction.failed');
    expect(raw.failureReason).toBe('INSUFFICIENT_FUNDS');
    expect(Array.isArray(raw.legs)).toBe(true);
    expect(raw.legs).toHaveLength(0); // no money moved
    expect(raw.owners).toHaveLength(0); // no legs -> no owners

    // The mapped read model also surfaces the A2 failureReason field.
    const doc = await repo.findById(ev.eventId);
    expect(doc.failureReason).toBe('INSUFFICIENT_FUNDS');

    expect(await pendingCount()).toBe(0);
  }, 60_000);

  it('proof 5: ensureGroup() is idempotent — a second call does not throw (BUSYGROUP handled), leaving exactly one group', async () => {
    // Fresh stream (beforeEach DEL): the first ensureGroup must CREATE (MKSTREAM), the
    // second must swallow BUSYGROUP.
    await consumer.ensureGroup();
    await consumer.ensureGroup();

    const groups: any = await redis.call('XINFO', 'GROUPS', STREAM);
    // XINFO GROUPS returns one entry per group. Tolerate the RESP2 flat field/value
    // array AND a RESP3 object, so the assertion is about the group set, not the codec.
    const nameOf = (g: any): string => {
      if (Array.isArray(g)) {
        for (let i = 0; i + 1 < g.length; i += 2) if (g[i] === 'name') return String(g[i + 1]);
        return '';
      }
      return g && typeof g === 'object' ? String(g.name ?? '') : '';
    };
    const analyticsGroups = (groups as any[]).filter((g) => nameOf(g) === GROUP);
    expect(analyticsGroups).toHaveLength(1); // created once, not duplicated/corrupted
  }, 60_000);

  it('proof 6: a malformed entry does not poison the batch nor get silently dropped — valid stored+acked, malformed stays pending', async () => {
    await createGroupRaw();

    // Malformed FIRST (structurally invalid: no `transaction`) so we prove the batch
    // continues past it to the valid entry.
    const malformed = {
      eventId: randomUUID(),
      eventType: 'transaction.posted',
      payloadJson: '{"schemaVersion":1,"occurredAt":"2026-09-08T12:00:00.000Z"}',
    };
    const valid = buildPosted();
    await xadd(malformed);
    await xadd(valid);

    // Drive twice (batch-size agnostic: COUNT=1 needs two passes to reach `valid`);
    // the call must never REJECT even though one entry fails to project.
    for (let i = 0; i < 2; i++) {
      await expect(consumer.consumeOnce()).resolves.toBeDefined();
    }

    expect(await docCount(valid.eventId)).toBe(1); // valid one stored + projected
    expect(await docCount(malformed.eventId)).toBe(0); // malformed one NOT stored
    // Money-safe "never silently drop": the malformed entry is left UNACKED (pending),
    // never acked-and-dropped. Exactly one entry (the malformed) remains pending.
    expect(await pendingCount()).toBe(1);
  }, 60_000);

  it('proof 7: a transient INFRA write fault (upsert rejects) is NOT swallowed as malformed — consumeOnce REJECTS, entry stays pending, a later reclaim recovers it (no loss)', async () => {
    await createGroupRaw();
    const ev = buildPosted({ amount: HUGE });
    await xadd(ev);

    // The poison-vs-infra distinction: a MALFORMED entry is logged + left unacked
    // WITHOUT throwing (proof 6), but a transient INFRA fault (e.g. Mongo down) must
    // PROPAGATE so the batch is retried — and, write-then-ack, the entry must stay
    // pending, never acked, never dropped. Spy the SAME repo instance the consumer
    // holds (singleton provider) so its upsert rejects exactly once.
    const spy = jest
      .spyOn(repo as { upsertByEventId: (doc: unknown) => Promise<void> }, 'upsertByEventId')
      .mockRejectedValueOnce(new Error('mongo down'));

    // The infra error propagates — it is NOT caught and treated as a malformed entry.
    await expect(consumer.consumeOnce()).rejects.toThrow();

    expect(await docCount(ev.eventId)).toBe(0); // write failed -> nothing persisted
    expect(await pendingCount()).toBe(1); // delivered but UN-acked (write-then-ack), not dropped

    // Recovery: restore the real write, then a reclaim pass picks up the pending entry.
    spy.mockRestore();
    await consumer.consumeOnce({ claimMinIdleMs: 0 });

    expect(await docCount(ev.eventId)).toBe(1); // no loss — the entry is recovered
    expect(await pendingCount()).toBe(0); // reclaimed + acked

    // Money survived the fault + recovery EXACTLY (bigint past 2^53, sum-zero legs).
    const doc = await repo.findById(ev.eventId);
    expect(doc).not.toBeNull();
    expect(typeof doc.amount).toBe('bigint');
    expect(doc.amount).toBe(HUGE);
    expect(doc.legs.reduce((a: bigint, l: any) => a + l.delta, 0n)).toBe(0n);
  }, 60_000);
});
