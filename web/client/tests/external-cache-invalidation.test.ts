import { configureStore } from '@reduxjs/toolkit';
import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's node fetch cannot resolve the app's relative `/api` base; make the same-origin base
// absolute against the test origin BEFORE baseApi captures the env at import (identical to the
// page/bearer tests). MSW resolves its relative handlers against the same origin, so requests match.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/api`);
});

import { accountsApi } from '../src/services/api/accountsApi';
import { transfersApi } from '../src/services/api/transfersApi';
import { baseApi } from '../src/services/api/baseApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import { projectAccounts, resetTransferStore } from '../src/mocks/state/transferStore';
import { resetPayeeStore } from '../src/mocks/state/payeeStore';
import { fixtureAccounts } from '../src/mocks/fixtures/accounts';
import { fixturePayees } from '../src/mocks/fixtures/payees';
import type { AccountDto } from '../src/services/api/contracts/accounts';

/**
 * THE MONEY-SAFETY CRUX of F4: the hold → cache-invalidation ASYMMETRY. A hold moves the money
 * boundary at a DIFFERENT time between internal and external transfers, so `transfersApi`'s cache
 * tags must NOT be symmetric (docs/README "Cache invalidation"; spec 04 external outbound). This
 * suite drives the REAL RTK Query mutations against the REAL MSW stub — nothing is mocked away — and
 * a live `getAccounts` subscription observes whether balances refetch, so a wrong tag is caught:
 *
 *  - EXTERNAL initiate places a hold NOW → MUST refetch accounts (available drops immediately);
 *  - EXTERNAL cancel releases the hold → MUST refetch accounts (available restored);
 *  - EXTERNAL confirm settles → MUST refetch accounts (balance decremented);
 *  - INTERNAL initiate moves nothing → MUST NOT refetch accounts;
 *  - INTERNAL cancel moves nothing → MUST NOT refetch accounts (a regression here — an internal
 *    cancel wrongly invalidating `Account` — is exactly what this guards).
 *
 * The counting handler returns `projectAccounts()`, so the assertion is both "a refetch happened"
 * AND "the refetched numbers are coherent with the hold" — a stronger proof than a bare counter.
 */

const SOURCE_ID = fixtureAccounts[0].id; // balance 1500000, held 0, available 1500000
const USABLE_PAYEE_ID = fixturePayees[0].id; // Landlord — usable
const SEEDED_DESTINATION = '2000000001';
const DEV_OTP_CODE = '123456';
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);
const AUTH = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
const url = (path: string) => new URL(path, window.location.origin).toString();

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

/** Count GET /api/accounts hits AND serve the live hold projection, so a refetch is observable and
 * the returned balances stay coherent with any placed/released/settled hold. */
function countAccountsFetches(): () => number {
  let count = 0;
  server.use(
    http.get('/api/accounts', () => {
      count += 1;
      return HttpResponse.json({ accounts: projectAccounts() });
    }),
  );
  return () => count;
}

type Store = ReturnType<typeof makeStore>;

/** Subscribe `getAccounts` for the store's lifetime (so an invalidation actually refetches) and wait
 * for the initial load to settle. */
async function subscribeAccounts(store: Store): Promise<void> {
  // Intentionally not unsubscribed — the subscription must outlive the mutations under test.
  const sub = store.dispatch(accountsApi.endpoints.getAccounts.initiate());
  await sub;
}

function sourceAvailable(store: Store): string | undefined {
  const data = accountsApi.endpoints.getAccounts.select()(store.getState()).data as
    AccountDto[] | undefined;
  return data?.find((a) => a.id === SOURCE_ID)?.available;
}

function sourceBalance(store: Store): string | undefined {
  const data = accountsApi.endpoints.getAccounts.select()(store.getState()).data as
    AccountDto[] | undefined;
  return data?.find((a) => a.id === SOURCE_ID)?.balance;
}

async function initiateExternal(store: Store, amount = '50000') {
  return store
    .dispatch(
      transfersApi.endpoints.initiateExternalTransfer.initiate({
        idempotencyKey: crypto.randomUUID(),
        sourceAccountId: SOURCE_ID,
        payeeId: USABLE_PAYEE_ID,
        amount,
        currency: 'MXN',
      }),
    )
    .unwrap();
}

/** Create an INTERNAL pending transfer through the store (resolving a token via a direct fetch
 * first, since the internal initiate requires a confirmation token). */
async function initiateInternal(store: Store) {
  const resolveRes = await fetch(url('/api/transfers/resolve-destination'), {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ accountNumber: SEEDED_DESTINATION }),
  });
  const { confirmationToken } = (await resolveRes.json()) as { confirmationToken: string };
  return store
    .dispatch(
      transfersApi.endpoints.initiateTransfer.initiate({
        idempotencyKey: crypto.randomUUID(),
        sourceAccountId: SOURCE_ID,
        destinationAccountNumber: SEEDED_DESTINATION,
        amount: '10050',
        currency: 'MXN',
        confirmationToken,
      }),
    )
    .unwrap();
}

beforeEach(async () => {
  resetTransferStore();
  resetPayeeStore();
  await userManager.storeUser(
    new User({
      access_token: 'invalidation-token',
      token_type: 'Bearer',
      session_state: null,
      scope: 'openid profile',
      expires_at: NOW_SECONDS() + 3600,
      profile: {
        sub: 'user-abc',
        iss: 'http://keycloak.localtest.me:8082/realms/supercool',
        aud: 'supercool-api',
        exp: NOW_SECONDS() + 3600,
        iat: NOW_SECONDS(),
      },
    }),
  );
});

afterEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
  resetTransferStore();
  resetPayeeStore();
});

describe('external transfer — invalidates the accounts cache (hold moves money now)', () => {
  it('external INITIATE refetches accounts and available drops by the amount', async () => {
    const fetches = countAccountsFetches();
    const store = makeStore();
    await subscribeAccounts(store);
    await waitFor(() => expect(fetches()).toBeGreaterThanOrEqual(1));
    const before = fetches();
    expect(sourceAvailable(store)).toBe('1500000');

    await initiateExternal(store, '50000');

    // The hold refetched the accounts AND the new available reflects it — both proven at once.
    await waitFor(() => expect(sourceAvailable(store)).toBe('1450000'));
    expect(fetches()).toBeGreaterThan(before);
  });

  it('external CANCEL refetches accounts and available is restored', async () => {
    const fetches = countAccountsFetches();
    const store = makeStore();
    await subscribeAccounts(store);
    const created = await initiateExternal(store, '50000');
    await waitFor(() => expect(sourceAvailable(store)).toBe('1450000'));
    const before = fetches();

    await store
      .dispatch(transfersApi.endpoints.cancelTransfer.initiate({ transferId: created.id }))
      .unwrap();

    await waitFor(() => expect(sourceAvailable(store)).toBe('1500000'));
    expect(fetches()).toBeGreaterThan(before);
  });

  it('external CONFIRM refetches accounts and balance is decremented (settle)', async () => {
    const fetches = countAccountsFetches();
    const store = makeStore();
    await subscribeAccounts(store);
    const created = await initiateExternal(store, '50000');
    await waitFor(() => expect(sourceAvailable(store)).toBe('1450000'));
    const before = fetches();

    await store
      .dispatch(
        transfersApi.endpoints.confirmTransfer.initiate({
          transferId: created.id,
          code: DEV_OTP_CODE,
        }),
      )
      .unwrap();

    await waitFor(() => expect(sourceBalance(store)).toBe('1450000'));
    expect(fetches()).toBeGreaterThan(before);
  });
});

describe('internal transfer — must NOT refetch the accounts cache (no hold, no money moved)', () => {
  it('internal INITIATE does not refetch accounts', async () => {
    const fetches = countAccountsFetches();
    const store = makeStore();
    await subscribeAccounts(store);
    await waitFor(() => expect(fetches()).toBeGreaterThanOrEqual(1));
    const before = fetches();

    await initiateInternal(store);

    // Give any mistaken Account invalidation the window a real refetch would resolve in, then prove
    // the count never moved — an internal initiate moves no money.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches()).toBe(before);
    expect(sourceAvailable(store)).toBe('1500000');
  });

  it('internal CANCEL does not refetch accounts (regression guard for the asymmetry)', async () => {
    const fetches = countAccountsFetches();
    const store = makeStore();
    await subscribeAccounts(store);
    const created = await initiateInternal(store);
    const before = fetches();

    await store
      .dispatch(transfersApi.endpoints.cancelTransfer.initiate({ transferId: created.id }))
      .unwrap();

    await new Promise((resolve) => setTimeout(resolve, 50));
    // The cancelled transfer's type is `internal`, so `cancelTransfer` must invalidate ONLY
    // PendingAuthorization — never `Account`. A wrong tag here would refetch balances after a
    // no-money-moved cancel.
    expect(fetches()).toBe(before);
    expect(sourceAvailable(store)).toBe('1500000');
  });
});
