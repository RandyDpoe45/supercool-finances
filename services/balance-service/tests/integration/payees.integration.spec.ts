/**
 * Spec 04 — Balance Service, External payees: enrollment END-TO-END at the service layer, driven
 * against the REAL DI'd PayeesService (resolved BY TOKEN through a booted AppModule) with real
 * Postgres. Written FROM the spec's "External payees" bullet + the developer-locked brief, NOT from
 * the implementor's code:
 *   - enrollment stamps `cooling_off_until = now() + PAYEE_COOLING_OFF_SECONDS` on the DB CLOCK and
 *     persists the CONSTANT outbound rail; a re-read via the service confirms it;
 *   - uniqueness `(owner_id, rail, destination_ref)`: a duplicate enrollment (same owner + same
 *     destinationRef) is `PayeeAlreadyEnrolledError`; a DIFFERENT owner may enroll the SAME ref;
 *   - a schema-level `uq_payee` proof (same triple → 23505; differing on ANY of the three inserts
 *     fine) — complements the canonical uq_payee proof in schema-constraints.integration.spec.ts,
 *     here tied to the enrollment defaults via `pg.insertExternalPayee`;
 *   - usability is DATE-gated, not status-driven: a PAST cooling_off row is usable and a FUTURE one
 *     is not (via the serializer), and READING a payee NEVER flips its status nor stamps activated_at;
 *   - `listPayees` is owner-scoped (never another user's payees).
 *
 * Why DB-backed and not mocked: the DB-clock cooling-off stamp, the `uq_payee` uniqueness, and the
 * "no activation side effect on read" invariant are properties of REAL rows — mocking them would
 * mock away the very behaviour under test. Every assertion gates on OBSERVABLE STATE (the persisted
 * row, its rail/status/activated_at, the re-read set), never on the error kind alone.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a false
 * pass). beforeAll TCP-probes Postgres and fails loud if unreachable; boots the real AppModule
 * (migrationsRun:true). jest.config.ts serializes the integration run (maxWorkers:1). Unique
 * owners/refs per test; committed rows cleaned up per-test. (Payee enrollment touches no Redis.)
 *
 * To run:
 *   BALANCE_INTEGRATION=1 [DB_HOST=… DB_PORT=…] npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import * as harness from '../support/harness';
import * as pg from '../support/pg';
import { completeRawEnv } from '../support/env.fixture';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED payees suite: set BALANCE_INTEGRATION=1 (and point DB_* at Postgres) to run it.',
  );
}

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');

const suite = ENABLED ? describe : describe.skip;

/** Resolve `serializePayee` via whichever accessor the harness exposes (best-effort). */
function resolveSerializePayee(): ((entity: any) => any) | undefined {
  try {
    const getOne = (harness as any).getPayeeSerializer;
    if (typeof getOne === 'function') {
      const s = getOne();
      if (typeof s === 'function') return s;
      if (s && typeof s.serializePayee === 'function') return s.serializePayee;
    }
    const getBag = (harness as any).getPayeeSerializers;
    if (typeof getBag === 'function') {
      const bag = getBag();
      if (bag && typeof bag.serializePayee === 'function') return bag.serializePayee;
    }
  } catch {
    /* best-effort */
  }
  return undefined;
}

suite(
  'external payee enrollment — DB-clock cooling-off + uniqueness + date-gating (integration, needs Postgres)',
  () => {
    let app: INestApplication;
    let ds: any;
    let svc: any;
    let outboundRail: string;
    let coolingOffSeconds: number;
    let domainErrors: any;
    const serializePayee = resolveSerializePayee();

    let trackedOwners: string[] = [];

    beforeAll(async () => {
      const reachable = await harness.tcpProbe(DB_HOST, DB_PORT);
      if (!reachable) {
        throw new Error(
          `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ${DB_HOST}:${DB_PORT}.`,
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
        OTP_HASH_SECRET: process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789',
      });
      for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

      const AppModule = harness.getAppModule();
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

      const token = (harness as any).getPayeesServiceToken?.();
      if (!token) {
        throw new Error(
          '[integration] BALANCE_INTEGRATION=1 but getPayeesServiceToken() is not resolvable via ' +
            'tests/support/harness.ts — reconcile the PAYEES_SERVICE token seam.',
        );
      }
      svc = app.get(token, { strict: false });
      if (!svc || typeof svc.registerPayee !== 'function' || typeof svc.listPayees !== 'function') {
        throw new Error(
          '[integration] resolved the payees service but it lacks registerPayee / listPayees. ' +
            'Reconcile the contract at tests/support/harness.ts:getPayeesServiceToken.',
        );
      }

      outboundRail = (harness as any).getOutboundRail?.();
      coolingOffSeconds = (harness as any).getPayeeCoolingOffSeconds?.();
      if (outboundRail === undefined || typeof coolingOffSeconds !== 'number') {
        throw new Error(
          '[integration] getOutboundRail() / getPayeeCoolingOffSeconds() are not resolvable via ' +
            'tests/support/harness.ts — reconcile the constant-rail + cooling-off config seams.',
        );
      }
      if (typeof (pg as any).insertExternalPayee !== 'function') {
        throw new Error(
          '[integration] pg.insertExternalPayee is not available in tests/support/pg.ts — the ' +
            'implementor owns this fixture; reconcile the FIXED support contract.',
        );
      }

      domainErrors = harness.getDomainErrors();
    }, 60_000);

    afterEach(async () => {
      const owners = trackedOwners;
      trackedOwners = [];
      if (owners.length) {
        try {
          await ds.query(`DELETE FROM external_payee WHERE owner_id = ANY($1)`, [owners]);
        } catch {
          /* best-effort; random ids keep re-runs safe */
        }
      }
    });

    afterAll(async () => {
      if (app) await app.close();
    });

    // ---- helpers -----------------------------------------------------------------------------

    function newOwner(): string {
      const o = `sub-${randomUUID()}`;
      trackedOwners.push(o);
      return o;
    }

    /** A 10-digit numeric external-bank-account ref (a shape the enrollment schema accepts). */
    function newRef(): string {
      return pg.localAccountNumber();
    }

    function idOf(r: any): string {
      return (r?.id ?? r?.payee?.id) as string;
    }

    async function register(
      owner: string,
      fields: { displayName: string; destinationRef: string; extra?: Record<string, unknown> },
    ): Promise<any> {
      return svc.registerPayee({
        ownerId: owner,
        sub: owner,
        displayName: fields.displayName,
        destinationRef: fields.destinationRef,
        ...(fields.extra ?? {}),
      });
    }

    async function listPayees(owner: string): Promise<any[]> {
      const r = await svc.listPayees(owner);
      return Array.isArray(r) ? r : (r?.payees ?? []);
    }

    async function payeeRow(id: string): Promise<any> {
      const r = await ds.query(
        `SELECT owner_id, display_name, rail, destination_ref, status, cooling_off_until, created_at, activated_at
         FROM external_payee WHERE id = $1`,
        [id],
      );
      return r[0];
    }

    function codeOf(err: any): string {
      if (
        domainErrors?.PayeeAlreadyEnrolledError &&
        err instanceof domainErrors.PayeeAlreadyEnrolledError
      ) {
        return 'PAYEE_ALREADY_ENROLLED';
      }
      return (err?.code ?? err?.driverError?.code ?? '') as string;
    }

    async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
      try {
        return { ok: true, value: await p };
      } catch (error) {
        return { ok: false, error };
      }
    }

    const withRollback = (fn: (q: any) => Promise<void>) => pg.withRollback(ds, fn);

    // ---- enrollment persists the DB-clock cooling-off + the constant rail --------------------

    it('registerPayee persists rail = the constant outbound rail and cooling_off_until ≈ now() + PAYEE_COOLING_OFF_SECONDS (DB clock)', async () => {
      const owner = newOwner();
      const ref = newRef();
      const before = Date.now();

      const created = await register(owner, { displayName: 'ACME Corp', destinationRef: ref });
      const id = idOf(created);
      expect(typeof id).toBe('string');

      const row = await payeeRow(id);
      expect(row.owner_id).toBe(owner);
      expect(row.destination_ref).toBe(ref);
      expect(row.rail).toBe(outboundRail); // the CONSTANT rail, never user-supplied

      // cooling_off_until is stamped on the DB clock to roughly now() + the configured window, and is
      // therefore still in the FUTURE right after enrollment (the payee is NOT yet usable).
      const coolMs = new Date(row.cooling_off_until).getTime();
      const expected = before + coolingOffSeconds * 1000;
      expect(coolMs).toBeGreaterThan(Date.now());
      // Tolerance: within half the window (or 60s, whichever is larger) of the expected instant — tight
      // enough to catch a wrong/zero window, loose enough for clock skew + test latency.
      const tolerance = Math.max(coolingOffSeconds * 1000 * 0.5, 60_000);
      expect(Math.abs(coolMs - expected)).toBeLessThan(tolerance);

      // Date-gated, not status-driven: enrollment stamps NO activation.
      expect(row.activated_at).toBeNull();

      // A re-read through the service confirms the row is enrolled for this owner.
      const listed = await listPayees(owner);
      expect(listed.map((p) => p.id)).toContain(id);
    }, 30_000);

    // ---- uniqueness (owner_id, rail, destination_ref) ---------------------------------------

    it('rejects a duplicate enrollment (same owner + same destinationRef) with PAYEE_ALREADY_ENROLLED; exactly one row persists', async () => {
      const owner = newOwner();
      const ref = newRef();

      const first = await register(owner, { displayName: 'ACME', destinationRef: ref });
      expect(idOf(first)).toBeTruthy();

      const dup = await capture(
        register(owner, { displayName: 'ACME Again', destinationRef: ref }),
      );
      expect(dup.ok).toBe(false);
      expect(codeOf(dup.error)).toBe('PAYEE_ALREADY_ENROLLED');

      const n = await ds.query(
        `SELECT count(*)::int AS n FROM external_payee WHERE owner_id = $1 AND destination_ref = $2`,
        [owner, ref],
      );
      expect(n[0].n).toBe(1); // the duplicate created nothing
    }, 30_000);

    it('a DIFFERENT owner may enroll the SAME destinationRef (uniqueness is per-owner)', async () => {
      const a = newOwner();
      const b = newOwner();
      const ref = newRef();

      const pa = await register(a, { displayName: 'ACME', destinationRef: ref });
      const pb = await register(b, { displayName: 'ACME', destinationRef: ref });

      expect(idOf(pa)).toBeTruthy();
      expect(idOf(pb)).toBeTruthy();
      expect(idOf(pa)).not.toBe(idOf(pb));
    }, 30_000);

    it('schema uq_payee: the same (owner_id, rail, destination_ref) collides (23505); differing on ANY one inserts fine', async () => {
      // Same triple → 23505.
      await withRollback(async (q) => {
        const owner = `sub-${randomUUID()}`;
        const rail = `rail-${randomUUID()}`;
        const ref = pg.localAccountNumber();
        await (pg as any).insertExternalPayee(q, { ownerId: owner, rail, destinationRef: ref });
        await pg.expectPgError(
          (pg as any).insertExternalPayee(q, { ownerId: owner, rail, destinationRef: ref }),
          pg.PG.UNIQUE_VIOLATION,
        );
      });

      // Differing on ANY of the three dimensions inserts fine.
      await withRollback(async (q) => {
        const owner = `sub-${randomUUID()}`;
        const rail = `rail-${randomUUID()}`;
        const ref = pg.localAccountNumber();
        await (pg as any).insertExternalPayee(q, { ownerId: owner, rail, destinationRef: ref });

        const diffRef = await (pg as any).insertExternalPayee(q, {
          ownerId: owner,
          rail,
          destinationRef: pg.localAccountNumber(),
        });
        const diffRail = await (pg as any).insertExternalPayee(q, {
          ownerId: owner,
          rail: `rail-${randomUUID()}`,
          destinationRef: ref,
        });
        const diffOwner = await (pg as any).insertExternalPayee(q, {
          ownerId: `sub-${randomUUID()}`,
          rail,
          destinationRef: ref,
        });
        expect(diffRef.id).toBeTruthy();
        expect(diffRail.id).toBeTruthy();
        expect(diffOwner.id).toBeTruthy();
      });
    }, 30_000);

    // ---- date-gating: PAST usable, FUTURE not; reading NEVER flips status / stamps activated_at ----

    it('date-gating (no status): PAST cooling_off is usable, FUTURE is not; reading leaves status + activated_at untouched', async () => {
      const owner = newOwner();

      // Seed one payee already OUT of cooling-off (past) and one still WITHIN it (future) — directly, so
      // the two date regimes are pinned regardless of the configured window.
      const past = await (pg as any).insertExternalPayee(ds, {
        ownerId: owner,
        displayName: 'Past Payee',
        destinationRef: newRef(),
        coolingOffUntil: new Date(Date.now() - 3_600_000),
      });
      const future = await (pg as any).insertExternalPayee(ds, {
        ownerId: owner,
        displayName: 'Future Payee',
        destinationRef: newRef(),
        coolingOffUntil: new Date(Date.now() + 3_600_000),
      });

      // Read them back through the service (entities) and serialize to get the derived `usable` flag.
      const listed = await listPayees(owner);
      const byId = new Map(listed.map((p) => [p.id, p]));
      const pastEntity = byId.get(past.id);
      const futureEntity = byId.get(future.id);
      expect(pastEntity).toBeTruthy();
      expect(futureEntity).toBeTruthy();

      if (serializePayee) {
        expect(serializePayee(pastEntity).usable).toBe(true); // now >= cooling_off_until
        expect(serializePayee(futureEntity).usable).toBe(false); // still cooling off
      } else {
        console.info(
          '[integration] serializePayee not resolvable — the usable flag is proven in the pure ' +
            'serializer unit suite; here only the no-activation-on-read DB invariant is asserted.',
        );
      }

      // No activation side effect on READ: status is UNCHANGED from insert and activated_at stays NULL.
      const pastRow = await payeeRow(past.id);
      const futureRow = await payeeRow(future.id);
      expect(pastRow.status).toBe(past.status); // still the DB default (reserved column, unused)
      expect(futureRow.status).toBe(future.status);
      expect(pastRow.activated_at).toBeNull();
      expect(futureRow.activated_at).toBeNull();
    }, 30_000);

    // ---- owner-scoping ----------------------------------------------------------------------

    it("listPayees returns ONLY the caller's payees (owner-scoped, never another user's)", async () => {
      const a = newOwner();
      const b = newOwner();
      const pa = await register(a, { displayName: 'A-payee', destinationRef: newRef() });
      const pb = await register(b, { displayName: 'B-payee', destinationRef: newRef() });

      const listedA = await listPayees(a);
      const idsA = listedA.map((p) => p.id);
      expect(idsA).toContain(idOf(pa));
      expect(idsA).not.toContain(idOf(pb));
    }, 30_000);
  },
);
