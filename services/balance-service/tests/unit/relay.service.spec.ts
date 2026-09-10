/**
 * Spec 04 — Balance Service, step 6: the outbox RELAY worker (`RelayService.drainOnce()`) driven
 * as a PURE unit (no DB, no real Redis) so it runs in the DEFAULT `npm test`. Written FROM the
 * spec's "Outbox + relay worker" bullet + `docs/ARCHITECTURE.md §7`, NOT from the implementor's
 * code.
 *
 * The invariant this suite pins — the one a fast pure test can catch and the one at-least-once
 * delivery RIDES ON — is the ORDERING inside a drain tick:
 *
 *     for each polled row:  XADD events:transactions ...          (publish FIRST)
 *     then, once ALL XADDs succeeded:  markPublished(ids)         (mark AFTER)
 *
 * so a crash / failure BETWEEN publish and mark re-publishes a duplicate (never loses), and the
 * row is only ever marked once its event is on the stream. Concretely:
 *   - drainOnce() XADDs each polled row to the literal stream key `events:transactions` with the
 *     field layout `event_id` (= the row id / dedup key), `event_type`, `payload` (JSON string of
 *     the row's payload), calls `markPublished` with EXACTLY the polled ids, and does so ONLY
 *     AFTER every XADD (asserted via a shared call-order recorder — not a hollow "was called");
 *     returns the count published this tick;
 *   - if an XADD THROWS, `markPublished` is NEVER called and the tick surfaces the error (⇒ the
 *     transaction rolls back and the row stays unpublished) — the ordering guarantee itself;
 *   - an empty poll returns 0 with no XADD and no markPublished (no work, no side effects).
 *
 * The NOT-mocked logic under test is the service's own drain sequencing. Collaborators (the outbox
 * repo, the ioredis client, the DataSource/transaction wrapper, the config) are MOCKED, matched by
 * DI token via a Nest TestingModule + `useMocker` (injection is order-independent). The
 * money-safety observables that only a real datastore can prove — SKIP LOCKED never double-
 * publishes across two instances, a failed publish leaves the row genuinely unpublished, a
 * redelivery carries the same event_id — are proven AUTHORITATIVELY in
 * tests/integration/relay.integration.spec.ts.
 *
 * Seams are resolved defensively (the implementor authors the harness accessors + the RelayService
 * in parallel): if the RelayService class / its token / its `drainOnce` are not yet resolvable, the
 * suite honest-SKIPs with a loud message rather than crashing (or silently passing) the default run.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import * as harness from '../support/harness';

function tryResolve<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

const STREAM_KEY = 'events:transactions';

const RelayService = tryResolve(() => (harness as any).getRelayService?.());
const RELAY_TOKEN = tryResolve(() => (harness as any).getRelayServiceToken?.());
const OUTBOX_REPO_TOKEN = tryResolve(() => (harness as any).getOutboxEventRepositoryToken?.());
const REDIS_TOKEN = tryResolve(() => harness.getRedisClientToken());
const APP_CONFIG_TOKEN = tryResolve(() => harness.getAppConfigToken());
const DS_TOKEN = tryResolve(() => getDataSourceToken());

const DRAIN_METHODS = ['drainOnce', 'drain', 'pollOnce', 'tick', 'runOnce'];

function pickMethodName(cls: any, names: string[]): string | undefined {
  const proto = cls?.prototype;
  if (!proto) return undefined;
  for (const n of names) if (typeof proto[n] === 'function') return n;
  return undefined;
}

const drainMethod = RelayService ? pickMethodName(RelayService, DRAIN_METHODS) : undefined;

const canRun = Boolean(RelayService && RELAY_TOKEN && OUTBOX_REPO_TOKEN && drainMethod);

if (!canRun) {
  console.info(
    '[unit] SKIPPED relay.service suite: could not resolve the RelayService class / its RELAY_SERVICE ' +
      'token / a drainOnce handler / the OUTBOX_EVENT_REPOSITORY token via tests/support/harness.ts ' +
      '(getRelayService / getRelayServiceToken / getOutboxEventRepositoryToken). Add the path/export ' +
      'there (the single coordination point) — the suite activates once the step-6 relay exists.',
  );
}

const suite = canRun ? describe : describe.skip;

/** A logging Proxy for any collaborator whose method names the implementor may vary — every access
 *  is a jest.fn(). Never used for the assertions that matter (those target the FIXED outbox-repo +
 *  redis method names). */
function autoMock(): any {
  const cache = new Map<PropertyKey, any>();
  const target: any = () => undefined;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (!cache.has(prop)) cache.set(prop, jest.fn());
      return cache.get(prop);
    },
    apply: () => undefined,
  });
}

interface Mocks {
  outboxRepo: any;
  redis: any;
  dataSource: any;
  appConfig: any;
  /** Ordered log of the side effects that carry the at-least-once invariant: every 'xadd' and the
   *  single 'markPublished', in the exact order they were invoked. */
  order: string[];
}

const BATCH_SIZE = 100;

/** One unpublished outbox row as the repo surfaces it (entity field names). `id` is the event_id. */
function outboxRow(seq: number): any {
  return {
    id: `evt-${seq}`,
    transactionId: `tx-${seq}`,
    eventType: 'transaction.posted',
    payload: { txId: `tx-${seq}`, type: 'internal', amount: '1000', seq },
    createdAt: new Date(Date.now() - (100 - seq) * 1000),
    publishedAt: null,
  };
}

function makeMocks(rows: any[], opts: { xaddThrowsAt?: number } = {}): Mocks {
  const order: string[] = [];

  let xaddCalls = 0;
  const redis = {
    // jest.fn records every arg the relay passes (asserted via parseXadd); the impl body ignores
    // them and only drives the ordering log + optional failure injection.
    xadd: jest.fn(async () => {
      const n = xaddCalls++;
      order.push('xadd');
      if (opts.xaddThrowsAt !== undefined && n >= opts.xaddThrowsAt) {
        throw new Error('redis XADD failed (WRONGTYPE / connection)');
      }
      // ioredis returns the generated stream entry id.
      return `169${n}-0`;
    }),
  };

  // Single-tick contract: pollUnpublished returns the batch ONCE (a real second tick would find
  // fewer rows, but drainOnce is exactly one batch); markPublished records the ids it marked.
  const outboxRepo = {
    pollUnpublished: jest.fn(async () => rows),
    markPublished: jest.fn(async (_qr: any, ids: string[]) => {
      order.push('markPublished');
      return ids.length;
    }),
  };

  const fakeManager = {
    query: jest.fn(async () => []),
    save: jest.fn(async (e: any) => e),
    getRepository: jest.fn(() => ({ save: jest.fn(async (e: any) => e) })),
  };
  const fakeQueryRunner: any = {
    manager: fakeManager,
    isTransactionActive: true,
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async () => []),
  };
  const dataSource = {
    // Supports whichever transaction seam the impl uses: `dataSource.transaction(cb)`,
    // `dataSource.createQueryRunner()` (manual), or a `runInTransactionWithRetry(dataSource, fn)`
    // helper (which itself calls createQueryRunner on this mock).
    transaction: jest.fn(async (arg1: any, arg2: any) => {
      const cb = typeof arg1 === 'function' ? arg1 : arg2;
      return cb(fakeManager);
    }),
    createQueryRunner: jest.fn(() => fakeQueryRunner),
    query: jest.fn(async () => []),
  };

  const appConfig = {
    relay: { enabled: false, pollIntervalMs: 500, batchSize: BATCH_SIZE },
    otp: { hashSecret: 'x'.repeat(24) },
    internalServiceToken: 'svc',
    rails: { webhookSigningSecret: 'test-rails-signing-secret' },
    payees: { coolingOffSeconds: 3600 },
  };

  return { outboxRepo, redis, dataSource, appConfig, order };
}

function isDataSourceToken(token: any): boolean {
  if (token === DataSource) return true;
  if (DS_TOKEN && token === DS_TOKEN) return true;
  return typeof token === 'string' && /datasource|connection/i.test(token);
}

async function setup(mocks: Mocks): Promise<any> {
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: RELAY_TOKEN as symbol, useClass: RelayService }],
  })
    .useMocker((token) => {
      if (token === OUTBOX_REPO_TOKEN) return mocks.outboxRepo;
      if (REDIS_TOKEN && token === REDIS_TOKEN) return mocks.redis;
      if (APP_CONFIG_TOKEN && token === APP_CONFIG_TOKEN) return mocks.appConfig;
      if (isDataSourceToken(token)) return mocks.dataSource;
      return autoMock();
    })
    .compile();
  // moduleRef.get (no app.init) → no OnModuleInit/lifecycle → the background loop never starts.
  return moduleRef.get(RELAY_TOKEN as symbol, { strict: false });
}

async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Parse an ioredis `xadd(key, id, f1, v1, f2, v2, ...)` call into { key, id, fields{} }. Robust to
 *  the impl passing the id as `'*'` and to extra leading options if any: it walks field/value PAIRS
 *  starting at the first arg after a `'*'` (or index 2 if none). */
function parseXadd(args: any[]): { key: string; fields: Record<string, any> } {
  const key = args[0];
  let start = args.indexOf('*');
  start = start >= 0 ? start + 1 : 2;
  const fields: Record<string, any> = {};
  for (let i = start; i + 1 < args.length; i += 2) {
    fields[String(args[i])] = args[i + 1];
  }
  return { key, fields };
}

suite('RelayService.drainOnce — publish-before-mark ordering (at-least-once keystone)', () => {
  it('XADDs each polled row to events:transactions with {event_id,event_type,payload}, then marks the polled ids AFTER every XADD, and returns the count', async () => {
    const rows = [outboxRow(1), outboxRow(2), outboxRow(3)];
    const mocks = makeMocks(rows);
    const service = await setup(mocks);

    const res = await capture(service[drainMethod!]());
    expect(res.ok).toBe(true);
    expect(res.value).toBe(rows.length); // returns rows published this tick

    // One XADD per polled row, to the LITERAL stream key, with the exact field layout.
    expect(mocks.redis.xadd).toHaveBeenCalledTimes(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const { key, fields } = parseXadd(mocks.redis.xadd.mock.calls[i]);
      expect(key).toBe(STREAM_KEY);
      // event_id IS the outbox row id (the analytics dedup key) — the whole point of the field.
      expect(fields.event_id).toBe(rows[i].id);
      expect(fields.event_type).toBe(rows[i].eventType);
      // payload is the JSON STRING of the row's payload (round-trips back to the object).
      expect(typeof fields.payload).toBe('string');
      expect(JSON.parse(fields.payload)).toEqual(rows[i].payload);
    }

    // markPublished got EXACTLY the polled ids (no more, no fewer — every published row is marked).
    expect(mocks.outboxRepo.markPublished).toHaveBeenCalledTimes(1);
    const markedIds = mocks.outboxRepo.markPublished.mock.calls[0][1];
    expect([...markedIds].sort()).toEqual(rows.map((r) => r.id).sort());

    // Polled with the configured batch size as the limit (locked signature pollUnpublished(qr, n)).
    expect(mocks.outboxRepo.pollUnpublished).toHaveBeenCalled();
    const pollArgs = mocks.outboxRepo.pollUnpublished.mock.calls[0];
    expect(pollArgs).toContain(BATCH_SIZE);

    // THE ORDERING INVARIANT (at-least-once): every XADD happens BEFORE the single mark. If the
    // impl marked first, a crash between mark and XADD would LOSE the event — this catches it.
    expect(mocks.order).toEqual(['xadd', 'xadd', 'xadd', 'markPublished']);
    const markIndex = mocks.order.indexOf('markPublished');
    const lastXaddIndex = mocks.order.lastIndexOf('xadd');
    expect(lastXaddIndex).toBeLessThan(markIndex);
  });

  it('if an XADD THROWS mid-tick, markPublished is NEVER called and drainOnce surfaces the error (⇒ rollback, row stays unpublished)', async () => {
    const rows = [outboxRow(1), outboxRow(2), outboxRow(3)];
    // The SECOND XADD throws (index 1): the first row was published, but the tick must NOT mark ANY
    // row — otherwise a partially-marked batch could drop the un-XADDed rows.
    const mocks = makeMocks(rows, { xaddThrowsAt: 1 });
    const service = await setup(mocks);

    const res = await capture(service[drainMethod!]());

    // The failure surfaces (so the surrounding transaction rolls back and nothing is marked).
    expect(res.ok).toBe(false);
    // The keystone: a failed publish tick marks NOTHING — mark comes strictly AFTER all XADDs, so a
    // thrown XADD aborts before the mark ever runs. This is exactly what makes at-least-once hold.
    expect(mocks.outboxRepo.markPublished).not.toHaveBeenCalled();
    expect(mocks.order).not.toContain('markPublished');
  });

  it('an empty poll returns 0 and performs no side effects (no XADD, no markPublished)', async () => {
    const mocks = makeMocks([]);
    const service = await setup(mocks);

    const res = await capture(service[drainMethod!]());
    expect(res.ok).toBe(true);
    expect(res.value).toBe(0);
    expect(mocks.redis.xadd).not.toHaveBeenCalled();
    expect(mocks.outboxRepo.markPublished).not.toHaveBeenCalled();
  });
});
