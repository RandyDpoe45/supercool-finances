/**
 * Spec 05 storage layer (step A1) — the `transactions` read-model substrate.
 *
 * Contract of record: specs/DATA-MODEL.md Part 2 (the STORED `transactions`
 * collection, its index list, the consumer-idempotency section) and
 * specs/analytics-schema.yaml. Written from that spec, NOT from the implementor's
 * code — it must be able to FAIL on a real defect, not ratify one.
 *
 * The DoD proof this suite anchors: "Publishing an event results in EXACTLY ONE Mongo
 * document, even when the event is redelivered." A1 builds the guarantee: the
 * `transactions` collection + an idempotent upsert keyed on `_id = event_id`, with
 * money stored as Mongo `Long` (int64) — never a float.
 *
 * Genuinely Mongo-dependent, so it follows the repo's honest-SKIP discipline (mirrors
 * health.integration.spec.ts): OPT-IN via ANALYTICS_INTEGRATION=1 (a default
 * `npm test` reports it SKIPPED — never a false pass); when opted in, it TCP-probes
 * Mongo first and fails LOUDLY if unreachable rather than silently degrading.
 *
 * To run:
 *   1. bring up the compose datastores (mongo reachable to the runner);
 *   2. export the analytics MONGO_* env (or rely on the defaults below);
 *   3. ANALYTICS_INTEGRATION=1 npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';

import {
  getConfigModule,
  getDatabaseModule,
  getPersistenceModule,
  getTransactionsRepositoryToken,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';

const ENABLED = process.env.ANALYTICS_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED transactions read-model suite: set ANALYTICS_INTEGRATION=1 ' +
      '(and point MONGO_HOST/MONGO_PORT/MONGO_USER/MONGO_PASSWORD/MONGO_DB/MONGO_AUTH_SOURCE ' +
      'at a reachable Mongo) to run it.',
  );
}

const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1';
const MONGO_PORT = Number(process.env.MONGO_PORT || '27017');
const COLLECTION = 'transactions';

const suite = ENABLED ? describe : describe.skip;

interface Leg {
  accountId: string;
  ownerId: string | null;
  accountKind: 'customer' | 'system';
  systemKey: string | null;
  delta: bigint;
  balanceAfter: bigint;
  currency: string;
}

interface TxDoc {
  _id: string;
  transactionId: string;
  eventType: string;
  type: string;
  status: string;
  amount: bigint;
  currency: string;
  initiatedBy: string;
  reversesTransactionId: string | null;
  payee: { id: string; displayName: string; rail: string } | null;
  legs: Leg[];
  owners: string[];
  occurredAt: Date;
}

/** null OR undefined — a nullable field that is faithfully UNSET (tolerant of the
 *  null-vs-undefined mapping, but still catches a wrong NON-null value). */
function nullish(v: unknown): boolean {
  return v === null || v === undefined;
}

/** A complete, valid `transactions` document with unique ids and sum-zero legs.
 *  Overrides let each test vary exactly the field it is exercising. */
function makeDoc(overrides: Partial<TxDoc> = {}): TxDoc {
  const owner = `sub-${randomUUID()}`;
  const doc: TxDoc = {
    _id: randomUUID(),
    transactionId: randomUUID(),
    eventType: 'transaction.posted',
    type: 'external_outbound',
    status: 'POSTED',
    amount: 50_000n,
    currency: 'MXN',
    initiatedBy: owner,
    reversesTransactionId: null,
    payee: { id: randomUUID(), displayName: 'ACME', rail: 'rail-outbound' },
    legs: [
      {
        accountId: randomUUID(),
        ownerId: owner,
        accountKind: 'customer',
        systemKey: null,
        delta: -50_000n,
        balanceAfter: 100_000n,
        currency: 'MXN',
      },
      {
        accountId: randomUUID(),
        ownerId: null,
        accountKind: 'system',
        systemKey: 'clearing:rail-outbound',
        delta: 50_000n,
        balanceAfter: 200_000n,
        currency: 'MXN',
      },
    ],
    owners: [owner],
    occurredAt: new Date('2026-09-08T12:00:00.000Z'),
  };
  return { ...doc, ...overrides };
}

suite('transactions read model (integration, needs Mongo)', () => {
  let app: INestApplication;
  let repo: any;
  let connection: any;
  const created: string[] = [];

  async function upsert(doc: TxDoc): Promise<void> {
    created.push(doc._id);
    await repo.upsertByEventId(doc);
  }

  beforeAll(async () => {
    const reachable = await tcpProbe(MONGO_HOST, MONGO_PORT);
    if (!reachable) {
      throw new Error(
        `[integration] ANALYTICS_INTEGRATION=1 but Mongo is not reachable at ` +
          `${MONGO_HOST}:${MONGO_PORT}. Bring up the compose datastores (and publish/point ` +
          `MONGO_HOST/MONGO_PORT at them) or unset ANALYTICS_INTEGRATION.`,
      );
    }

    const env = completeRawEnv({
      MONGO_HOST,
      MONGO_PORT: String(MONGO_PORT),
      MONGO_DB: process.env.MONGO_DB || 'analytics',
      MONGO_USER: process.env.MONGO_USER || 'analytics_app',
      MONGO_PASSWORD: process.env.MONGO_PASSWORD || 'changeme-analytics-local',
      MONGO_AUTH_SOURCE: process.env.MONGO_AUTH_SOURCE || 'analytics',
    });
    for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

    const moduleRef = await Test.createTestingModule({
      imports: [getConfigModule(), getDatabaseModule(), getPersistenceModule()],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // establishes the real Mongo connection + registers the model

    repo = app.get(getTransactionsRepositoryToken(), { strict: false });
    connection = app.get(getConnectionToken(), { strict: false });

    // Build the specced indexes deterministically before the index assertion runs
    // (rather than racing autoIndex). ensureIndexes also creates the namespace.
    for (const name of connection.modelNames()) {
      await connection.model(name).ensureIndexes();
    }
  }, 60_000);

  afterEach(async () => {
    // Re-runnable: drop only the docs this file created (never nuke the collection).
    if (connection?.db && created.length) {
      await connection.db.collection(COLLECTION).deleteMany({ _id: { $in: created.splice(0) } });
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('upserts EXACTLY ONE document per event_id — a redelivery (same _id) never duplicates', async () => {
    // The core spec-05 DoD: at-least-once redelivery yields exactly one document.
    const doc = makeDoc();
    await upsert(doc);
    // Redelivery: the SAME event arrives again (same _id). Must be a no-op replay — a
    // plain insert would throw a duplicate-key error; a random-id insert would make two.
    await repo.upsertByEventId(doc);

    const coll = connection.db.collection(COLLECTION);
    expect(await coll.countDocuments({ _id: doc._id })).toBe(1);
    expect(await coll.countDocuments({ transactionId: doc.transactionId })).toBe(1);

    const read = await repo.findById(doc._id);
    expect(read).not.toBeNull();
    expect(read.transactionId).toBe(doc.transactionId);
  });

  it('stores money as int64 (Long), not float — values > 2^53 round-trip EXACTLY as bigint', async () => {
    // 2^53 + 1 is the smallest positive integer NOT representable as a float64 double;
    // int64 max stresses the top of the range. If money were ever floated, these round
    // back CHANGED. Exact bigint equality here is the proof it was stored as an integer.
    const HUGE = 9_007_199_254_740_993n; // 2^53 + 1
    const MAX_I64 = 9_223_372_036_854_775_807n; // int64 max
    const doc = makeDoc({
      amount: MAX_I64,
      legs: [
        {
          accountId: randomUUID(),
          ownerId: `sub-${randomUUID()}`,
          accountKind: 'customer',
          systemKey: null,
          delta: -HUGE,
          balanceAfter: HUGE,
          currency: 'MXN',
        },
        {
          accountId: randomUUID(),
          ownerId: null,
          accountKind: 'system',
          systemKey: 'clearing:rail-outbound',
          delta: HUGE,
          balanceAfter: MAX_I64,
          currency: 'MXN',
        },
      ],
    });
    await upsert(doc);

    const read = await repo.findById(doc._id);
    expect(read).not.toBeNull();
    expect(typeof read.amount).toBe('bigint');
    expect(read.amount).toBe(MAX_I64);

    for (const leg of read.legs) {
      expect(typeof leg.delta).toBe('bigint');
      expect(typeof leg.balanceAfter).toBe('bigint');
    }
    // Order-independent, but exact: both large magnitudes survive the round-trip.
    const deltas = read.legs.map((l: any) => l.delta);
    expect(deltas).toContain(HUGE);
    expect(deltas).toContain(-HUGE);
    const balances = read.legs.map((l: any) => l.balanceAfter);
    expect(balances).toContain(HUGE);
    expect(balances).toContain(MAX_I64);

    // Secondary, storage-level proof: the STORED BSON type is `long`, never a float64
    // `double` (nor Decimal128). $type uses Mongo's own type system, so it is robust to
    // how the driver promotes Longs on read — an integer > 2^53 could not sit in a
    // `double` slot without loss, so a `double` count here would be the smoking gun.
    const coll = connection.db.collection(COLLECTION);
    const q = { _id: doc._id };
    expect(await coll.countDocuments({ ...q, amount: { $type: 'long' } })).toBe(1);
    expect(await coll.countDocuments({ ...q, amount: { $type: 'double' } })).toBe(0);
    expect(await coll.countDocuments({ ...q, 'legs.delta': { $type: 'long' } })).toBe(1);
    expect(await coll.countDocuments({ ...q, 'legs.delta': { $type: 'double' } })).toBe(0);
    expect(await coll.countDocuments({ ...q, 'legs.balanceAfter': { $type: 'long' } })).toBe(1);
    expect(await coll.countDocuments({ ...q, 'legs.balanceAfter': { $type: 'double' } })).toBe(0);
  });

  it('round-trips every field faithfully — payee object|null, reverses null|set, legs, owners, occurredAt', async () => {
    const owner1 = `sub-${randomUUID()}`;
    const owner2 = `sub-${randomUUID()}`;
    const occurred = new Date('2026-09-08T12:34:56.000Z');

    // Doc A: posted external_outbound — payee OBJECT, reverses NULL, two distinct owners,
    // legs summing to zero (a positive + a negative delta).
    const a = makeDoc({
      eventType: 'transaction.posted',
      type: 'external_outbound',
      status: 'POSTED',
      amount: 75_000n,
      reversesTransactionId: null,
      payee: { id: randomUUID(), displayName: 'ACME S.A.', rail: 'rail-outbound' },
      owners: [owner1, owner2],
      occurredAt: occurred,
      legs: [
        {
          accountId: randomUUID(),
          ownerId: owner1,
          accountKind: 'customer',
          systemKey: null,
          delta: -75_000n,
          balanceAfter: 25_000n,
          currency: 'MXN',
        },
        {
          accountId: randomUUID(),
          ownerId: owner2,
          accountKind: 'customer',
          systemKey: null,
          delta: 75_000n,
          balanceAfter: 175_000n,
          currency: 'MXN',
        },
      ],
    });

    // Doc B: reversal — payee NULL, reverses SET, a system leg (ownerId null, systemKey set).
    const reversedTxId = randomUUID();
    const b = makeDoc({
      eventType: 'transaction.reversed',
      type: 'internal',
      status: 'REVERSED',
      amount: 30_000n,
      reversesTransactionId: reversedTxId,
      payee: null,
      owners: [owner1],
      occurredAt: occurred,
      legs: [
        {
          accountId: randomUUID(),
          ownerId: owner1,
          accountKind: 'customer',
          systemKey: null,
          delta: 30_000n,
          balanceAfter: 55_000n,
          currency: 'MXN',
        },
        {
          accountId: randomUUID(),
          ownerId: null,
          accountKind: 'system',
          systemKey: 'clearing:internal',
          delta: -30_000n,
          balanceAfter: -30_000n,
          currency: 'MXN',
        },
      ],
    });

    await upsert(a);
    await upsert(b);

    const readA = await repo.findById(a._id);
    expect(readA).not.toBeNull();
    expect(readA.transactionId).toBe(a.transactionId);
    expect(readA.eventType).toBe('transaction.posted');
    expect(readA.type).toBe('external_outbound');
    expect(readA.status).toBe('POSTED');
    expect(readA.amount).toBe(75_000n);
    expect(readA.currency).toBe('MXN');
    expect(readA.initiatedBy).toBe(a.initiatedBy);
    expect(nullish(readA.reversesTransactionId)).toBe(true); // the NULL case
    // payee OBJECT faithful on its three specced fields.
    expect(readA.payee).not.toBeNull();
    expect(readA.payee.id).toBe(a.payee!.id);
    expect(readA.payee.displayName).toBe('ACME S.A.');
    expect(readA.payee.rail).toBe('rail-outbound');
    expect(new Set(readA.owners)).toEqual(new Set([owner1, owner2]));
    expect(readA.occurredAt instanceof Date).toBe(true);
    expect(readA.occurredAt.getTime()).toBe(occurred.getTime());
    expect(readA.legs).toHaveLength(2);
    expect(readA.legs[0].accountId).toBe(a.legs[0].accountId);
    expect(readA.legs[0].ownerId).toBe(owner1);
    expect(readA.legs[0].accountKind).toBe('customer');
    expect(nullish(readA.legs[0].systemKey)).toBe(true);
    expect(readA.legs[0].delta).toBe(-75_000n);
    expect(readA.legs[0].balanceAfter).toBe(25_000n);
    expect(readA.legs[0].currency).toBe('MXN');

    const readB = await repo.findById(b._id);
    expect(readB).not.toBeNull();
    expect(readB.eventType).toBe('transaction.reversed');
    expect(readB.status).toBe('REVERSED');
    expect(readB.reversesTransactionId).toBe(reversedTxId); // the SET case
    expect(nullish(readB.payee)).toBe(true); // the NULL case
    const systemLeg = readB.legs.find((l: any) => l.accountKind === 'system');
    expect(systemLeg).toBeDefined();
    expect(nullish(systemLeg.ownerId)).toBe(true); // system leg has no customer owner
    expect(systemLeg.systemKey).toBe('clearing:internal');
    expect(typeof systemLeg.delta).toBe('bigint');
    expect(systemLeg.delta).toBe(-30_000n);
  });

  it('preserves the double-entry invariant on the read side: SUM(legs[].delta) === 0n', async () => {
    // Analytics can re-assert money conservation from what it stored. Summing with a
    // bigint seed also proves every delta came back a bigint (mixing bigint + number
    // throws) — a second guard against a floated/stringified delta.
    const owner = `sub-${randomUUID()}`;
    const doc = makeDoc({
      owners: [owner],
      legs: [
        {
          accountId: randomUUID(),
          ownerId: owner,
          accountKind: 'customer',
          systemKey: null,
          delta: -123_456_789n,
          balanceAfter: 10n,
          currency: 'MXN',
        },
        {
          accountId: randomUUID(),
          ownerId: null,
          accountKind: 'system',
          systemKey: 'clearing:rail-outbound',
          delta: 100_000_000n,
          balanceAfter: 500n,
          currency: 'MXN',
        },
        {
          accountId: randomUUID(),
          ownerId: null,
          accountKind: 'system',
          systemKey: 'clearing:fees',
          delta: 23_456_789n,
          balanceAfter: 999n,
          currency: 'MXN',
        },
      ],
    });
    await upsert(doc);

    const read = await repo.findById(doc._id);
    expect(read).not.toBeNull();
    const sum = read.legs.reduce((acc: bigint, l: any) => acc + l.delta, 0n);
    expect(sum).toBe(0n);
  });

  it('creates the specced indexes on the transactions collection (key patterns)', async () => {
    const indexes = await connection.db.collection(COLLECTION).listIndexes().toArray();
    const patterns = indexes.map((i: any) => JSON.stringify(i.key));
    const has = (key: Record<string, number>): boolean => patterns.includes(JSON.stringify(key));

    // The event-dedup gate: the default _id index is unique by construction (no need to
    // over-specify the option flag — asserting the key pattern is the robust check).
    expect(has({ _id: 1 })).toBe(true);
    expect(has({ transactionId: 1 })).toBe(true);
    expect(has({ occurredAt: -1 })).toBe(true);
    // Compound field ORDER is load-bearing (prefix must be the equality field).
    expect(has({ owners: 1, occurredAt: -1 })).toBe(true);
    expect(has({ type: 1, occurredAt: -1 })).toBe(true);
    expect(has({ 'legs.accountId': 1 })).toBe(true); // multikey — per-account $group
  });
});
