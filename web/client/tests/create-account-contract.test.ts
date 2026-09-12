import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountDto,
  AccountsResponse,
  StatementResponse,
} from '../src/services/api/contracts/accounts';
import type { ErrorResponse } from '../src/services/api/contracts/error';
import { resetAccountStore } from '../src/mocks/state/accountStore';
import { fixtureAccounts } from '../src/mocks/fixtures/accounts';

/**
 * The create-account MSW stub (`POST /balance/api/accounts`) must honor the REAL balance-service
 * wire contract so the SPA is developed against the exact shape + status codes the backend emits.
 * Expectations come from the CONTRACT OF RECORD (specs/07 + specs/04 + the account serializer /
 * `.strict()` `{ label }` schema) — NOT from the stub's own values. This is the headline guard:
 *
 *  - a created account is money-safe BY CONSTRUCTION: zero balances, `active`/`customer`/`MXN`, a
 *    fresh 10-digit number — every one of those is server-owned, so the body carries ONLY `label`
 *    and any extra key is rejected (a client must not be able to pre-set a balance, status, or id);
 *  - the account then appears in `GET /accounts` and its statement is an EMPTY list, not a 404
 *    (a brand-new account has no ledger history but is still owned/visible);
 *  - the per-customer cap holds: from the seeded slate exactly the remaining slots may be opened,
 *    the next collides 422 `ACCOUNT_LIMIT_REACHED`, and a rejected create adds nothing;
 *  - the label rule (trimmed, 1..50 chars, no control chars) and 401 gate are enforced.
 *
 * `resetAccountStore()` runs around every test because the created-account state lives at module
 * scope and the shared `setup.ts` only resets MSW handlers, not this store.
 */

const ORIGIN = window.location.origin;
const url = (path: string) => new URL(path, ORIGIN).toString();
const AUTH = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };

// The EXACT whitelist the account serializer emits — `label` included. A leaked internal column
// (owner ids, spend counters, timestamps) would diverge from this and fail.
const ACCOUNT_FIELDS = [
  'accountNumber',
  'available',
  'balance',
  'currency',
  'held',
  'id',
  'kind',
  'label',
  'status',
].sort();
// Internal columns the service deliberately withholds — none may reach the wire.
const FORBIDDEN_FIELDS = [
  'ownerId',
  'systemKey',
  'spentToday',
  'spentMonth',
  'spentTodayDate',
  'spentMonthDate',
  'createdAt',
  'updatedAt',
];

// The documented per-customer cap and seeded baseline (specs/07). The cap counts seeded + created,
// so from the pristine slate only these many slots remain openable.
const MAX_ACCOUNTS_PER_CUSTOMER = 5;
const SEEDED_ACCOUNTS = fixtureAccounts.length;
const OPENABLE_SLOTS = MAX_ACCOUNTS_PER_CUSTOMER - SEEDED_ACCOUNTS;

const TEN_DIGITS = /^\d{10}$/;

// A C0 control character (BEL, U+0007) built at runtime rather than embedded as a raw byte in the
// source: an explicit, editor-visible construction that survives formatters / line-ending
// normalization. Placed mid-string in the label below so it isn't stripped by the server's trim.
const CONTROL_CHAR = String.fromCharCode(0x07);

async function createAccount(
  body: Record<string, unknown>,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return fetch(url('/balance/api/accounts'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function listAccounts(headers: Record<string, string> = AUTH): Promise<AccountDto[]> {
  const res = await fetch(url('/balance/api/accounts'), { headers });
  const { accounts } = (await res.json()) as AccountsResponse;
  return accounts;
}

function expectNoForbiddenFields(record: object) {
  for (const field of FORBIDDEN_FIELDS) {
    expect(record).not.toHaveProperty(field);
  }
}

beforeEach(() => resetAccountStore());
afterEach(() => resetAccountStore());

describe('POST /balance/api/accounts — a money-safe account minted from just { label }', () => {
  it('the documented seeded baseline is 2, so exactly 3 slots remain (guards the cap arithmetic)', () => {
    // A defensive pin: if the seed count changes, the cap boundary below must be re-derived.
    expect(SEEDED_ACCOUNTS).toBe(2);
    expect(OPENABLE_SLOTS).toBe(3);
  });

  it('returns 201 with EXACTLY the whitelisted DTO keys and no internal columns', async () => {
    const res = await createAccount({ label: 'Vacation Fund' });
    expect(res.status).toBe(201);
    const account = (await res.json()) as AccountDto;
    expect(Object.keys(account).sort()).toEqual(ACCOUNT_FIELDS);
    expectNoForbiddenFields(account);
  });

  it('mints zero balances, active/customer/MXN, a fresh 10-digit number, and the trimmed label', async () => {
    const account = (await (await createAccount({ label: 'Vacation Fund' })).json()) as AccountDto;

    // Money-safe by construction: a brand-new account holds nothing.
    expect(account.balance).toBe('0');
    expect(account.held).toBe('0');
    expect(account.available).toBe('0');
    // available is DERIVED (balance − held), never independent — proven with exact bigint math.
    expect(account.available).toBe((BigInt(account.balance) - BigInt(account.held)).toString());

    expect(account.status).toBe('active');
    expect(account.kind).toBe('customer');
    expect(account.currency).toBe('MXN');
    expect(account.accountNumber).toMatch(TEN_DIGITS);
    expect(account.label).toBe('Vacation Fund');
  });

  it('trims surrounding whitespace on the label before persisting it', async () => {
    const account = (await (await createAccount({ label: '  Rainy Day  ' })).json()) as AccountDto;
    expect(account.label).toBe('Rainy Day');
  });

  it('accepts the 1-char and 50-char length boundaries (off-by-one guard)', async () => {
    expect((await createAccount({ label: 'a' })).status).toBe(201);
    expect((await createAccount({ label: 'a'.repeat(50) })).status).toBe(201);
  });

  it('the created account then appears in GET /accounts with the same whitelist and zeros', async () => {
    const created = (await (await createAccount({ label: 'Vacation Fund' })).json()) as AccountDto;

    const accounts = await listAccounts();
    const found = accounts.find((a) => a.id === created.id);
    expect(found).toBeDefined();
    expect(Object.keys(found!).sort()).toEqual(ACCOUNT_FIELDS);
    expectNoForbiddenFields(found!);
    expect(found!.label).toBe('Vacation Fund');
    expect(found!.balance).toBe('0');
    expect(found!.available).toBe('0');
    // It is folded ALONGSIDE the seeded accounts, not in place of them (never double-counted).
    expect(accounts).toHaveLength(SEEDED_ACCOUNTS + 1);
  });

  it("a newly created account's statement is an EMPTY entries list, not a 404", async () => {
    const created = (await (await createAccount({ label: 'Vacation Fund' })).json()) as AccountDto;

    const res = await fetch(url(`/balance/api/accounts/${created.id}/transactions`), {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatementResponse;
    expect(body.accountId).toBe(created.id);
    expect(body.entries).toEqual([]);
  });
});

describe('POST /balance/api/accounts — the per-customer cap (422 ACCOUNT_LIMIT_REACHED)', () => {
  it('opens accounts up to the cap, then rejects the next and adds nothing', async () => {
    // Fill every remaining slot — each of these must succeed.
    for (let i = 0; i < OPENABLE_SLOTS; i += 1) {
      const res = await createAccount({ label: `Account ${i}` });
      expect(res.status).toBe(201);
    }
    // At the cap the customer's account count is exactly the maximum.
    expect(await listAccounts()).toHaveLength(MAX_ACCOUNTS_PER_CUSTOMER);

    // One over the cap collides with the domain code (mirrors the service's 422).
    const over = await createAccount({ label: 'One Too Many' });
    expect(over.status).toBe(422);
    expect(((await over.json()) as ErrorResponse).error.code).toBe('ACCOUNT_LIMIT_REACHED');

    // The rejected create must not have opened an account — the count is unchanged.
    expect(await listAccounts()).toHaveLength(MAX_ACCOUNTS_PER_CUSTOMER);
  });
});

describe('POST /balance/api/accounts — .strict() label validation (400)', () => {
  it.each([
    ['missing label', {}],
    ['empty label', { label: '' }],
    ['whitespace-only label (trims to nothing)', { label: '   ' }],
    ['label longer than 50 chars', { label: 'a'.repeat(51) }],
    // A control character mid-string survives the trim and must be rejected.
    ['label with a control character', { label: `Sav${CONTROL_CHAR}ings` }],
    // A smuggled server-owned field must be rejected — a client cannot pre-set a balance/status/id.
    ['an extra body key (balance)', { label: 'Ok', balance: '9999' }],
    ['an extra body key (status)', { label: 'Ok', status: 'frozen' }],
    ['an extra body key (id)', { label: 'Ok', id: 'attacker-chosen' }],
  ])('rejects %s with 400', async (_name, body) => {
    const res = await createAccount(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('BAD_REQUEST');
  });

  it('a rejected (invalid) create opens no account — the seeded count is untouched', async () => {
    expect((await createAccount({ label: '   ' })).status).toBe(400);
    expect(await listAccounts()).toHaveLength(SEEDED_ACCOUNTS);
  });
});

describe('POST /balance/api/accounts — requires a gateway identity (401)', () => {
  it('rejects a request with no bearer and leaks no account', async () => {
    const res = await createAccount(
      { label: 'Vacation Fund' },
      { 'Content-Type': 'application/json' },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponse & { id?: unknown; accountNumber?: unknown };
    expect(body.error.code.length).toBeGreaterThan(0);
    expect(body.id).toBeUndefined();
    expect(body.accountNumber).toBeUndefined();

    // Nothing was created — an authed list still shows only the seeded accounts.
    expect(await listAccounts()).toHaveLength(SEEDED_ACCOUNTS);
  });
});
