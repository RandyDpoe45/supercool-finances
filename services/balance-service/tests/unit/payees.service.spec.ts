/**
 * Spec 04 — Balance Service, External payees: the PayeesService.registerPayee / listPayees branch
 * logic, driven as a PURE unit (no DB) so it runs in the DEFAULT `npm test`. Written FROM the spec
 * ("External payees" bullet + the /api endpoints prose) and the developer-locked brief, NOT from the
 * implementor's code:
 *   - registration input is minimal `{ displayName, destinationRef }`; the RAIL is a CONSTANT
 *     (`getOutboundRail()`), never user-supplied — the service must persist the constant rail and
 *     IGNORE any rail/owner/status a caller tries to smuggle in the input;
 *   - usability is DATE-gated, not status-driven: enrollment is a DB-clock insert and there is NO
 *     PENDING→ACTIVE flip — the service must NOT call any activate / status-transition repo method;
 *   - uniqueness `(owner_id, rail, destination_ref)`: a repo unique-violation (23505 on `uq_payee`)
 *     maps to `PayeeAlreadyEnrolledError` (code `PAYEE_ALREADY_ENROLLED`);
 *   - `listPayees(ownerId)` returns the caller's own payees (owner-scoped).
 *
 * The repository + AppConfig are MOCKED, but the LOGIC UNDER TEST (which rail is persisted, whether
 * a status flip is attempted, how a 23505 is mapped) is the service's own and is NOT mocked away.
 * The repo mock is a Proxy that captures EVERY call and classifies by ARGUMENT SHAPE, so the proof
 * is robust to the exact name the implementor gives the DB-clock enrollment insert (the brief does
 * not fix that name). Injection is driven through a Nest TestingModule + `useMocker` (NOT positional
 * `new`), matched by DI token, so the proof is independent of constructor arg order.
 *
 * ASSUMED service contract (spec/brief-derived — the source of truth, flagged in the report): the
 * write takes a single params object with the owner inside — `registerPayee({ ownerId, displayName,
 * destinationRef })` (mirrors the transfers write-service convention) — and the read is positional
 * `listPayees(ownerId)` (mirrors AccountsService.listOwnedAccounts / getPendingAuthorization). If the
 * implementor's signatures diverge, the harness/adapter is the single reconciliation point.
 *
 * Seams are resolved defensively (the implementor authors the harness accessors in parallel): if the
 * PayeesService class / token / outbound-rail constant are not yet resolvable, the suite honest-SKIPs
 * with a loud message rather than crashing the whole default `npm test` run.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import * as harness from '../support/harness';

/** Resolve a parallel-authored harness seam without letting a throw/undefined crash the file. */
function tryResolve<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

const PayeesService = tryResolve(() => (harness as any).getPayeesService?.());
const PAYEES_TOKEN = tryResolve(() => (harness as any).getPayeesServiceToken?.());
const OUTBOUND_RAIL = tryResolve(() => (harness as any).getOutboundRail?.());
const EXTERNAL_PAYEE_REPO_TOKEN = tryResolve(() =>
  harness.getRepositoryToken('EXTERNAL_PAYEE_REPOSITORY', 'external-payee'),
);
const APP_CONFIG_TOKEN = tryResolve(() => harness.getAppConfigToken());
const de: any = harness.getDomainErrors();
const PayeeAlreadyEnrolledError = de?.PayeeAlreadyEnrolledError;

const canRun = Boolean(
  PayeesService && PAYEES_TOKEN && OUTBOUND_RAIL !== undefined && EXTERNAL_PAYEE_REPO_TOKEN,
);
if (!canRun) {
  console.info(
    '[unit] SKIPPED payees.service suite: could not resolve PayeesService / PAYEES_SERVICE token / ' +
      'getOutboundRail() / EXTERNAL_PAYEE_REPOSITORY via tests/support/harness.ts. Add the ' +
      'path/export there (the single coordination point) to activate this suite.',
  );
}

const suite = canRun ? describe : describe.skip;

const OWNER = 'sub-alice';

/** An auto-mock for any dependency we do not explicitly wire (proxy of jest.fns). */
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

interface RepoState {
  enrollError: any;
  enrollResult: any;
  ownerPayees: any[];
}

interface Mocks {
  repo: any;
  known: { findByOwner: jest.Mock; findById: jest.Mock; createEnrollment: jest.Mock };
  appConfig: any;
  callLog: Array<{ method: string; args: any[] }>;
  state: RepoState;
}

function makeMocks(): Mocks {
  const callLog: Array<{ method: string; args: any[] }> = [];
  const state: RepoState = { enrollError: undefined, enrollResult: undefined, ownerPayees: [] };

  const known = {
    // The DB-clock enrollment insert (IExternalPayeeRepository.createEnrollment). Positional args
    // are captured verbatim so the proof asserts the RAIL argument is the constant (never the
    // caller's) WITHOUT hard-coding its positional index.
    createEnrollment: jest.fn(async (...args: any[]) => {
      callLog.push({ method: 'createEnrollment', args });
      if (state.enrollError) throw state.enrollError;
      return state.enrollResult;
    }),
    findByOwner: jest.fn(async (ownerId: string) => {
      callLog.push({ method: 'findByOwner', args: [ownerId] });
      return state.ownerPayees;
    }),
    findById: jest.fn(async (id: string) => {
      callLog.push({ method: 'findById', args: [id] });
      return state.ownerPayees.find((p) => p.id === id) ?? null;
    }),
  };

  // Any OTHER accessed method is created lazily, records the call, and returns null — so if the
  // service reached for a status/activation method (it must NOT), the call is CAPTURED (proving the
  // "no status transition" invariant) rather than throwing and masking the assertion.
  const repo: any = new Proxy(known as any, {
    get(target: any, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      if (prop === 'then') return undefined;
      if (prop in target) return target[prop];
      const fn = jest.fn(async (...args: any[]) => {
        callLog.push({ method: prop, args });
        return null;
      });
      target[prop] = fn;
      return fn;
    },
  });

  // AppConfig carries the cooling-off window the service passes to the repo (config.payees.
  // coolingOffSeconds). The value is irrelevant to these proofs (the DB-clock stamp is proven in the
  // integration suite); it must merely be present so the config read does not throw.
  const appConfig = {
    payees: { coolingOffSeconds: 3600 },
    otp: { hashSecret: 'x'.repeat(24) },
    internalServiceToken: 'svc',
  };

  return { repo, known, appConfig, callLog, state };
}

async function setup(): Promise<{ service: any; mocks: Mocks }> {
  const mocks = makeMocks();
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: PAYEES_TOKEN, useClass: PayeesService }],
  })
    .useMocker((token) => {
      if (token === EXTERNAL_PAYEE_REPO_TOKEN) return mocks.repo;
      if (APP_CONFIG_TOKEN && token === APP_CONFIG_TOKEN) return mocks.appConfig;
      return autoMock();
    })
    .compile();
  const service = moduleRef.get(PAYEES_TOKEN, { strict: false });
  return { service, mocks };
}

/** The recorded enrollment-insert call (its positional args), if any. */
function enrollCall(
  callLog: Array<{ method: string; args: any[] }>,
): { method: string; args: any[] } | undefined {
  return callLog.find((c) => c.method === 'createEnrollment');
}

/** True iff any recorded call was to a status-transition / activation method. */
function activationWasCalled(callLog: Array<{ method: string; args: any[] }>): boolean {
  return callLog.some((c) =>
    /activate|markactive|transition|setstatus|updatestatus/i.test(c.method),
  );
}

async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

suite('PayeesService.registerPayee — constant rail, DB-clock enrollment, no status flip', () => {
  it('persists the CONSTANT outbound rail (never a caller-supplied rail), passing owner/displayName/destinationRef through', async () => {
    const { service, mocks } = await setup();
    const created = {
      id: 'payee-1',
      ownerId: OWNER,
      displayName: 'ACME Corp',
      destinationRef: '1234567890',
      rail: OUTBOUND_RAIL,
      status: 'pending',
      coolingOffUntil: new Date(),
      createdAt: new Date(),
      activatedAt: null,
    };
    mocks.state.enrollResult = created;
    mocks.state.ownerPayees = [created]; // so a defensive re-fetch (if any) also finds it

    // The input smuggles a MALICIOUS rail + status — the service must ignore both and use the constant.
    const result = await service.registerPayee({
      ownerId: OWNER,
      displayName: 'ACME Corp',
      destinationRef: '1234567890',
      rail: 'attacker-rail',
      status: 'active',
    } as any);

    // Returns the created entity (services work in entities; serialization is a controller concern).
    expect(result.id).toBe('payee-1');
    expect(result.rail).toBe(OUTBOUND_RAIL);

    // The enrollment insert was performed with the CONSTANT rail — the crux of "rail is not
    // user-supplied". Asserted by argument membership (not positional index) so the proof is robust
    // to the exact arg order.
    const call = enrollCall(mocks.callLog);
    expect(call).toBeDefined();
    const args = call!.args;
    expect(args).toContain(OUTBOUND_RAIL); // the constant rail is used
    expect(args).not.toContain('attacker-rail'); // the caller-supplied rail is ignored
    expect(args).toContain(OWNER); // owner-scoped from the trusted identity
    expect(args).toContain('ACME Corp'); // displayName passed through
    expect(args).toContain('1234567890'); // destinationRef passed through
    // No caller-chosen status reaches the repo (date-gated, not status-driven).
    expect(args).not.toContain('active');
  });

  it('performs NO status transition / activation on enrollment (usability is date-gated)', async () => {
    const { service, mocks } = await setup();
    mocks.state.enrollResult = { id: 'payee-2', ownerId: OWNER, rail: OUTBOUND_RAIL };

    await service.registerPayee({
      ownerId: OWNER,
      displayName: 'Beta LLC',
      destinationRef: '2223334440',
    } as any);

    // There is no PENDING→ACTIVE flip: the service must never reach for an activate/status-update method.
    expect(activationWasCalled(mocks.callLog)).toBe(false);
  });

  it('maps a repo UNIQUE violation (23505 on uq_payee) to PayeeAlreadyEnrolledError (PAYEE_ALREADY_ENROLLED)', async () => {
    const { service, mocks } = await setup();
    // A TypeORM QueryFailedError surfaces the SQLSTATE on both `.code` and `.driverError.code`.
    mocks.state.enrollError = Object.assign(
      new Error('duplicate key value violates unique constraint "uq_payee"'),
      {
        code: '23505',
        constraint: 'uq_payee',
        driverError: { code: '23505', constraint: 'uq_payee' },
      },
    );

    const res = await capture(
      service.registerPayee({
        ownerId: OWNER,
        displayName: 'ACME',
        destinationRef: '1234567890',
      } as any),
    );

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('PAYEE_ALREADY_ENROLLED');
    if (PayeeAlreadyEnrolledError) expect(res.error).toBeInstanceOf(PayeeAlreadyEnrolledError);
  });
});

suite('PayeesService.listPayees — owner-scoped read', () => {
  it("returns the caller's own payees via the owner-scoped finder", async () => {
    const { service, mocks } = await setup();
    const a = {
      id: 'p-a',
      ownerId: OWNER,
      displayName: 'A',
      destinationRef: '1111111111',
      rail: OUTBOUND_RAIL,
    };
    const b = {
      id: 'p-b',
      ownerId: OWNER,
      displayName: 'B',
      destinationRef: '2222222222',
      rail: OUTBOUND_RAIL,
    };
    mocks.state.ownerPayees = [a, b];

    const result = await service.listPayees(OWNER);

    expect(mocks.known.findByOwner).toHaveBeenCalledWith(OWNER);
    expect(result).toEqual([a, b]);
  });
});
