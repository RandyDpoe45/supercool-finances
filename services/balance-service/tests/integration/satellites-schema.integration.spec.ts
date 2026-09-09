/**
 * Spec 04 — Balance Service persistence layer, STEP 2 schema (the "satellite" tables
 * that hang off the Step-1 core).
 *
 * Written from the SCHEMA MANIFEST (specs/balance-schema.yaml) and the data-model
 * (specs/DATA-MODEL.md Part 1 "Enumerations" + per-entity invariants), NOT from the
 * implementor's migration. Assertions are derived from the manifest, so a deviation
 * in snake_case names, enum types/labels, defaults, constraints, or indexes FAILS the
 * test — that is the point (tests encode intended behaviour, not the code as written).
 *
 * Scope (Step 2 only): the 6 tables `hold`, `user_limits`, `outbox_event`,
 * `audit_log`, `approval_request`, `idempotency_key` and the 5 native enum types
 * `hold_status`, `user_limits_scope`, `approval_action`, `approval_status`,
 * `idempotency_status`. The Step-1 core tables/enums are covered by
 * `schema-constraints.integration.spec.ts`; here they appear only as FK parents.
 *
 * Honest-SKIP discipline (see tests/README.md): OPT-IN via BALANCE_INTEGRATION=1 (a
 * default `npm test` reports it SKIPPED — never a false pass), TCP-probe Postgres in
 * beforeAll (fail loud if unreachable), boot the real AppModule (which runs BOTH
 * migrations on boot, migrationsRun:true), resolve the DataSource, drive raw SQL.
 * Every mutating assertion runs inside an always-rolled-back QueryRunner transaction
 * (shared helper), so the suite is idempotent; seed rows use random ids.
 *
 * To run:
 *   1. bring up the compose datastores (Postgres reachable to the test runner);
 *   2. export the balance service's DB_* env (or rely on the defaults below);
 *   3. BALANCE_INTEGRATION=1 npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { getAppModule, tcpProbe } from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';
import {
  PG,
  withRollback as withRollbackOn,
  insertRow,
  insertAccount,
  insertTransaction,
  expectPgError,
  seedTestCurrency,
} from '../support/pg';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED satellites-schema suite: set BALANCE_INTEGRATION=1 (and ' +
      'point DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME at a reachable Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

const suite = ENABLED ? describe : describe.skip;

// ---- Step-2 enum types + labels, straight from DATA-MODEL.md "Enumerations" --------
const EXPECTED_ENUMS: Record<string, string[]> = {
  hold_status: ['PLACED', 'SETTLED', 'RELEASED', 'EXPIRED'],
  user_limits_scope: ['global', 'customer'],
  approval_action: ['reversal', 'user_limits_change', 'adjustment'],
  approval_status: ['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED'],
  idempotency_status: ['in_progress', 'completed'],
};

const soon = () => new Date(Date.now() + 3_600_000).toISOString();

suite('balance schema — Step 2 satellite tables (integration, needs Postgres)', () => {
  let app: INestApplication;
  let ds: any;

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
    await app.init(); // runs BOTH migrations on boot (migrationsRun: true)

    try {
      const { DataSource } = require('typeorm');
      ds = app.get(DataSource);
    } catch {
      const { getDataSourceToken } = require('@nestjs/typeorm');
      ds = app.get(getDataSourceToken());
    }
    if (!ds) throw new Error('[integration] could not resolve the TypeORM DataSource from the app');
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  const withRollback = (fn: (q: any) => Promise<void>) => withRollbackOn(ds, fn);

  // Currency + account + transaction parents that hold/outbox FKs require.
  async function seedParents(q: any): Promise<{ acc: any; tx: any }> {
    await seedTestCurrency(q);
    const acc = await insertAccount(q);
    const tx = await insertTransaction(q);
    return { acc, tx };
  }

  // ---- Structure: tables + enum types ---------------------------------------------

  it('creates the six Step-2 tables', async () => {
    const rows: Array<{ table_name: string }> = await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      'hold',
      'user_limits',
      'outbox_event',
      'audit_log',
      'approval_request',
      'idempotency_key',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('creates the five Step-2 native enum types with exactly the manifest labels', async () => {
    const rows: Array<{ typname: string; labels: string[] }> = await ds.query(
      `SELECT t.typname AS typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typtype = 'e' AND n.nspname = 'public'
        GROUP BY t.typname`,
    );
    const byName = new Map(rows.map((r) => [r.typname, r.labels]));
    for (const [name, labels] of Object.entries(EXPECTED_ENUMS)) {
      expect(byName.has(name)).toBe(true);
      expect([...(byName.get(name) ?? [])].sort()).toEqual([...labels].sort());
    }
  });

  // ---- Native enum enforcement (22P02), one column per enum type ------------------

  it('rejects an invalid hold_status label (native enum)', async () => {
    await withRollback(async (q) => {
      const { acc, tx } = await seedParents(q);
      await expectPgError(
        insertRow(q, 'hold', {
          account_id: acc.id,
          transaction_id: tx.id,
          amount: 100,
          status: 'bogus',
          rail: 'rail-outbound',
          expires_at: soon(),
        }),
        PG.INVALID_ENUM_TEXT,
      );
    });
  });

  it('rejects an invalid user_limits_scope label (native enum)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      await expectPgError(
        insertRow(q, 'user_limits', { scope: 'bogus', owner_id: null, currency: 'TST' }),
        PG.INVALID_ENUM_TEXT,
      );
    });
  });

  it('rejects an invalid approval_action label (native enum)', async () => {
    await withRollback(async (q) => {
      await expectPgError(
        insertRow(q, 'approval_request', {
          action_type: 'bogus',
          payload: JSON.stringify({}),
          maker_id: 'admin-1',
        }),
        PG.INVALID_ENUM_TEXT,
      );
    });
  });

  it('rejects an invalid approval_status label (native enum)', async () => {
    await withRollback(async (q) => {
      await expectPgError(
        insertRow(q, 'approval_request', {
          action_type: 'reversal',
          payload: JSON.stringify({}),
          maker_id: 'admin-1',
          status: 'bogus',
        }),
        PG.INVALID_ENUM_TEXT,
      );
    });
  });

  it('rejects an invalid idempotency_status label (native enum)', async () => {
    await withRollback(async (q) => {
      await expectPgError(
        insertRow(q, 'idempotency_key', {
          owner_id: `sub-${randomUUID()}`,
          key: `idem-${randomUUID()}`,
          request_fingerprint: 'fp',
          status: 'bogus',
          expires_at: soon(),
        }),
        PG.INVALID_ENUM_TEXT,
      );
    });
  });

  // ---- hold: amount CHECK, FKs, status default ------------------------------------

  it('rejects a hold with amount <= 0 (CHECK amount > 0)', async () => {
    await withRollback(async (q) => {
      const { acc, tx } = await seedParents(q);
      await expectPgError(
        insertRow(q, 'hold', {
          account_id: acc.id,
          transaction_id: tx.id,
          amount: 0,
          rail: 'rail-outbound',
          expires_at: soon(),
        }),
        PG.CHECK_VIOLATION,
      );
    });
    await withRollback(async (q) => {
      const { acc, tx } = await seedParents(q);
      await expectPgError(
        insertRow(q, 'hold', {
          account_id: acc.id,
          transaction_id: tx.id,
          amount: -100,
          rail: 'rail-outbound',
          expires_at: soon(),
        }),
        PG.CHECK_VIOLATION,
      );
    });
  });

  it('rejects a hold referencing a non-existent account or transaction (FK)', async () => {
    await withRollback(async (q) => {
      const { tx } = await seedParents(q);
      await expectPgError(
        insertRow(q, 'hold', {
          account_id: randomUUID(), // no such account
          transaction_id: tx.id,
          amount: 100,
          rail: 'rail-outbound',
          expires_at: soon(),
        }),
        PG.FK_VIOLATION,
      );
    });
    await withRollback(async (q) => {
      const { acc } = await seedParents(q);
      await expectPgError(
        insertRow(q, 'hold', {
          account_id: acc.id,
          transaction_id: randomUUID(), // no such transaction
          amount: 100,
          rail: 'rail-outbound',
          expires_at: soon(),
        }),
        PG.FK_VIOLATION,
      );
    });
  });

  it('defaults a new hold to status=PLACED (only PLACED counts toward account.held)', async () => {
    await withRollback(async (q) => {
      const { acc, tx } = await seedParents(q);
      const hold = await insertRow(q, 'hold', {
        account_id: acc.id,
        transaction_id: tx.id,
        amount: 5000,
        rail: 'rail-outbound',
        expires_at: soon(),
      });
      expect(hold.status).toBe('PLACED');
    });
  });

  // ---- user_limits: UNIQUE (scope, owner_id) with NULLS NOT DISTINCT --------------

  it('rejects a SECOND global user_limits row (unique NULLS NOT DISTINCT on scope+owner_id)', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      await insertRow(q, 'user_limits', { scope: 'global', owner_id: null, currency: 'TST' });
      // A plain UNIQUE would treat the two NULL owner_ids as distinct and WRONGLY allow
      // a second global row; NULLS NOT DISTINCT must reject it. This is the whole point
      // of the constraint (exactly one global baseline).
      await expectPgError(
        insertRow(q, 'user_limits', { scope: 'global', owner_id: null, currency: 'TST' }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  it('allows a global baseline and a per-customer override to coexist', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const g = await insertRow(q, 'user_limits', {
        scope: 'global',
        owner_id: null,
        currency: 'TST',
      });
      const c = await insertRow(q, 'user_limits', {
        scope: 'customer',
        owner_id: `sub-${randomUUID()}`,
        currency: 'TST',
      });
      expect(g.id).toBeTruthy();
      expect(c.id).toBeTruthy();
      expect(g.id).not.toBe(c.id);
    });
  });

  it('rejects two customer user_limits rows with the same owner_id', async () => {
    await withRollback(async (q) => {
      await seedTestCurrency(q);
      const owner = `sub-${randomUUID()}`;
      await insertRow(q, 'user_limits', { scope: 'customer', owner_id: owner, currency: 'TST' });
      await expectPgError(
        insertRow(q, 'user_limits', { scope: 'customer', owner_id: owner, currency: 'TST' }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  // ---- outbox_event: partial index, default, FK -----------------------------------

  it('defaults outbox_event.published_at to NULL and enforces the transaction FK', async () => {
    await withRollback(async (q) => {
      const { tx } = await seedParents(q);
      const ev = await insertRow(q, 'outbox_event', {
        transaction_id: tx.id,
        event_type: 'transaction.posted',
        payload: JSON.stringify({ hello: 'world' }),
      });
      expect(ev.published_at).toBeNull(); // unpublished until the relay stamps it

      await expectPgError(
        insertRow(q, 'outbox_event', {
          transaction_id: randomUUID(), // no such transaction
          event_type: 'transaction.posted',
          payload: JSON.stringify({}),
        }),
        PG.FK_VIOLATION,
      );
    });
  });

  // ---- audit_log: bigint IDENTITY + NOT NULL --------------------------------------

  it('auto-assigns a monotonically increasing bigint id to audit_log (IDENTITY)', async () => {
    await withRollback(async (q) => {
      const r1 = await insertRow(q, 'audit_log', {
        actor_id: `admin-${randomUUID()}`,
        action: 'account.freeze',
      });
      const r2 = await insertRow(q, 'audit_log', {
        actor_id: `admin-${randomUUID()}`,
        action: 'limit.update',
      });
      expect(r1.id).toBeTruthy();
      expect(r2.id).toBeTruthy();
      // bigint comes back as a string from node-pg; compare as BigInt.
      expect(BigInt(r2.id) > BigInt(r1.id)).toBe(true);
    });
  });

  it('requires audit_log.actor_id and audit_log.action (NOT NULL)', async () => {
    await withRollback(async (q) => {
      await expectPgError(insertRow(q, 'audit_log', { action: 'account.freeze' }), PG.NOT_NULL);
    });
    await withRollback(async (q) => {
      await expectPgError(
        insertRow(q, 'audit_log', { actor_id: `admin-${randomUUID()}` }),
        PG.NOT_NULL,
      );
    });
  });

  // ---- approval_request: four-eyes CHECK + status default -------------------------

  it('enforces the four-eyes CHECK (checker_id <> maker_id); allows checker_id NULL or a different admin', async () => {
    // checker == maker -> rejected
    await withRollback(async (q) => {
      await expectPgError(
        insertRow(q, 'approval_request', {
          action_type: 'reversal',
          payload: JSON.stringify({}),
          maker_id: 'admin-1',
          checker_id: 'admin-1',
        }),
        PG.CHECK_VIOLATION,
      );
    });
    // checker != maker, and checker NULL -> both allowed
    await withRollback(async (q) => {
      const different = await insertRow(q, 'approval_request', {
        action_type: 'reversal',
        payload: JSON.stringify({}),
        maker_id: 'admin-1',
        checker_id: 'admin-2',
      });
      const undecided = await insertRow(q, 'approval_request', {
        action_type: 'reversal',
        payload: JSON.stringify({}),
        maker_id: 'admin-1',
        checker_id: null,
      });
      expect(different.id).toBeTruthy();
      expect(undecided.id).toBeTruthy();
    });
  });

  it('defaults approval_request.status to PENDING (only APPROVED may later EXECUTE)', async () => {
    await withRollback(async (q) => {
      const ar = await insertRow(q, 'approval_request', {
        action_type: 'reversal',
        payload: JSON.stringify({}),
        maker_id: `admin-${randomUUID()}`,
      });
      expect(ar.status).toBe('PENDING');
    });
  });

  // ---- idempotency_key: composite PK + indexes ------------------------------------

  it('enforces the composite PK (owner_id, key): dup rejected, same key under a different owner allowed', async () => {
    await withRollback(async (q) => {
      const owner = `sub-${randomUUID()}`;
      const key = `idem-${randomUUID()}`;
      await insertRow(q, 'idempotency_key', {
        owner_id: owner,
        key,
        request_fingerprint: 'fp-1',
        status: 'in_progress',
        expires_at: soon(),
      });
      // Same key, DIFFERENT owner -> allowed (keys are namespaced per caller).
      const otherOwner = await insertRow(q, 'idempotency_key', {
        owner_id: `sub-${randomUUID()}`,
        key,
        request_fingerprint: 'fp-2',
        status: 'in_progress',
        expires_at: soon(),
      });
      expect(otherOwner.key).toBe(key);
      // Same (owner_id, key) again -> rejected by the composite PK.
      await expectPgError(
        insertRow(q, 'idempotency_key', {
          owner_id: owner,
          key,
          request_fingerprint: 'fp-3',
          status: 'completed',
          expires_at: soon(),
        }),
        PG.UNIQUE_VIOLATION,
      );
    });
  });

  // ---- Indexes fixed by the data-model --------------------------------------------

  it('creates the partial outbox relay index and the idempotency lookup indexes', async () => {
    const rows: Array<{ indexname: string; indexdef: string; tablename: string }> = await ds.query(
      `SELECT indexname, indexdef, tablename FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef.toLowerCase()]));

    // idx_outbox_unpublished (created_at) WHERE published_at IS NULL — the relay poll.
    expect(byName.has('idx_outbox_unpublished')).toBe(true);
    const outboxDef = byName.get('idx_outbox_unpublished') ?? '';
    expect(outboxDef).toContain('created_at');
    expect(outboxDef).toContain('where');
    expect(outboxDef).toContain('published_at');
    expect(outboxDef).toContain('null'); // partial predicate: WHERE published_at IS NULL

    // idx_idem_expires (expires_at) — the retention sweep.
    expect(byName.has('idx_idem_expires')).toBe(true);
    expect(byName.get('idx_idem_expires')).toContain('expires_at');

    // The soft-duplicate lookup index over (owner_id, request_fingerprint, created_at).
    // The manifest fixes the columns but not a name, so assert by content on the table.
    const idemDefs = rows
      .filter((r) => r.tablename === 'idempotency_key')
      .map((r) => r.indexdef.toLowerCase());
    const hasFingerprintIndex = idemDefs.some(
      (def) =>
        def.includes('owner_id') &&
        def.includes('request_fingerprint') &&
        def.includes('created_at'),
    );
    expect(hasFingerprintIndex).toBe(true);
  });

  it('creates idx_hold_account_placed as a partial index scoped to PLACED holds', async () => {
    const rows: Array<{ indexname: string; indexdef: string }> = await ds.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef.toLowerCase()]));

    // Not manifest-mandated, but a shipped index backing the hold reconciliation query
    // (SUM(amount) WHERE status='PLACED' per account == account.held). Guard it so a
    // regression that drops it or unscopes it off PLACED is caught.
    expect(byName.has('idx_hold_account_placed')).toBe(true);
    const def = byName.get('idx_hold_account_placed') ?? '';
    expect(def).toContain('account_id');
    expect(def).toContain('where');
    expect(def).toContain('placed');
  });
});
