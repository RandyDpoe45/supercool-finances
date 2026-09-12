import type { AccountDto } from '../../services/api/contracts/accounts';
import { fixtureAccounts } from '../fixtures/accounts';

/**
 * In-memory CREATED-account state for the MSW stub, mirroring the balance-service
 * `POST /api/accounts` closely enough to exercise the client flow WITHOUT a backend: a minimal
 * `{ label }` body mints a money-safe account (zero balances, `active`/`customer`/`MXN`, a fresh
 * 10-digit account number), and the per-customer account cap collides once the total reaches
 * {@link MAX_ACCOUNTS_PER_CUSTOMER} (→ 422 `ACCOUNT_LIMIT_REACHED`).
 *
 * This store holds ONLY the accounts the customer creates at runtime. The SEEDED accounts stay in
 * `fixtures/accounts.ts` and are served (with any live external-hold projection) by
 * `transferStore.projectAccounts()`; the `GET /api/accounts` handler folds THIS store's created
 * accounts onto that result, so an account appears in exactly one place and is never double-counted.
 * The cap counts the seeded accounts (`fixtureAccounts.length`) plus the created ones.
 *
 * State lives at module scope; `resetAccountStore()` clears the created accounts so a test starts
 * from the pristine seeded slate. The stub has a single implicit caller, so `ownerId` is not
 * modeled — every created account belongs to that caller.
 */

/** The per-customer account cap, matching the balance-service limit. */
export const MAX_ACCOUNTS_PER_CUSTOMER = 5;

/** Base for minted account numbers — a distinct 10-digit range from the seeded customer accounts
 * (`10000000xx`) and the transfer destinations (`20000000xx`), so a created number never collides. */
const CREATED_ACCOUNT_NUMBER_BASE = 3_000_000_001;

interface StoredAccount {
  id: string;
  accountNumber: string;
  label: string;
  currency: string;
  status: AccountDto['status'];
  kind: AccountDto['kind'];
  /** Canonical minor-unit strings. A freshly created account is always zero. */
  balance: string;
  held: string;
}

let createdAccounts: StoredAccount[] = [];

/** Reset (clear) the created accounts — for test isolation; the seeded fixtures are untouched. */
export function resetAccountStore(): void {
  createdAccounts = [];
}

/** Serialize a stored account to the wire DTO, whitelisting each field and deriving `available` at
 * read time (`balance - held`, bigint math) exactly like the service serializer. Internal columns
 * are never modeled, so they can never leak. */
export function serializeAccountDto(account: StoredAccount): AccountDto {
  const available = (BigInt(account.balance) - BigInt(account.held)).toString();
  return {
    id: account.id,
    currency: account.currency,
    status: account.status,
    kind: account.kind,
    balance: account.balance,
    held: account.held,
    available,
    accountNumber: account.accountNumber,
    label: account.label,
  };
}

/** The customer's created accounts (insertion order). */
export function listCreatedAccounts(): StoredAccount[] {
  return createdAccounts;
}

/** True iff `id` names one of the customer's created accounts — the statement handler consults this
 * so a newly created account (which has no ledger history yet) resolves to an EMPTY statement rather
 * than a 404, while a truly unknown id still 404s. */
export function isKnownAccountId(id: string): boolean {
  return createdAccounts.some((account) => account.id === id);
}

export type CreateAccountResult =
  { outcome: 'created'; account: StoredAccount } | { outcome: 'limit-reached' };

/** Open a new money-safe account for the caller. Collides with `limit-reached` (→ 422) once the
 * total account count (seeded + created) has reached the per-customer cap. */
export function createAccount(params: { label: string }): CreateAccountResult {
  if (fixtureAccounts.length + createdAccounts.length >= MAX_ACCOUNTS_PER_CUSTOMER) {
    return { outcome: 'limit-reached' };
  }
  const account: StoredAccount = {
    id: crypto.randomUUID(),
    accountNumber: String(CREATED_ACCOUNT_NUMBER_BASE + createdAccounts.length),
    label: params.label,
    currency: 'MXN',
    status: 'active',
    kind: 'customer',
    balance: '0',
    held: '0',
  };
  createdAccounts.push(account);
  return { outcome: 'created', account };
}
