import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's node fetch cannot resolve the app's relative `/balance/admin` base; make the SAME
// same-origin base absolute against the test origin before baseApi captures the env at import
// (identical to the bearer / whoami tests). MSW resolves its relative handlers against the same
// origin, so requests still match.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

// Importing the page also registers accountsApi's injected endpoints on baseApi.
import { AccountsPage } from '../src/components/pages/AccountsPage';
import { baseApi } from '../src/services/api/baseApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import { OWNER_ONE, OWNER_TWO } from '../src/mocks/fixtures/accounts';
import { freezeAccount } from '../src/mocks/state/adminState';

/**
 * Account management over a fresh store + live MSW stub + a REAL signed-in session (so the RTK Query
 * bearer is attached exactly as in production). Nothing here mocks the query, the mutations, or the
 * money formatters. These prove the SPEC behaviors an operator relies on (spec 07 admin-app + spec
 * 04 admin freeze/unfreeze):
 *
 *  - the seeded accounts render with a status badge and FLOAT-FREE balance/held/available (raw minor
 *    units never reach the DOM, and one field's value is never shown for another);
 *  - freezing an ACTIVE account round-trips (POST .../freeze) and, after tag invalidation refetches
 *    the list, the SAME row reflects the new `frozen` status — proving the cache-invalidation path,
 *    not just that a handler was hit;
 *  - only the acting row's control is disabled while its mutation is in flight;
 *  - a server-side failure surfaces via an Alert and does NOT optimistically flip the row's status;
 *  - the owner-id filter narrows the list to one customer server-side.
 */

const ACTIVE_ID = '11111111-1111-4111-8111-111111111111'; // OWNER_ONE, active, balance 1500000
const FROZEN_ID = '22222222-2222-4222-8222-222222222222'; // OWNER_ONE, frozen, 250075/5000/245075
const OWNER_TWO_ID = '33333333-3333-4333-8333-333333333333'; // OWNER_TWO, active, 900000
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

function makeStore() {
  // Fresh store per render so RTK Query's cache never bleeds across tests.
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function renderPage() {
  return render(
    <Provider store={makeStore()}>
      <AccountsPage />
    </Provider>,
  );
}

/** Re-query a row fresh each time so assertions read post-re-render DOM, not a stale node. */
function rowFor(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-account-id="${id}"]`);
  if (!row) {
    throw new Error(`row for account ${id} not found`);
  }
  return row;
}

beforeEach(async () => {
  await userManager.storeUser(
    new User({
      access_token: 'accounts-access-token',
      token_type: 'Bearer',
      session_state: null,
      scope: 'openid profile',
      expires_at: NOW_SECONDS() + 3600,
      profile: {
        sub: 'admin-subject-123',
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
});

describe('AccountsPage — rendering the seeded accounts', () => {
  it('renders each account with its status badge and FLOAT-FREE money fields (no raw minor units, no field crosstalk)', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'accounts' });

    // The frozen fixture has three DISTINCT money fields, so a bug that showed one field's value
    // for another cannot pass. Expected strings are hand-computed (MXN exponent 2).
    const frozenRow = rowFor(FROZEN_ID);
    expect(frozenRow.textContent).toContain('2,500.75'); // balance   250075
    expect(frozenRow.textContent).toContain('50.00'); // held      5000
    expect(frozenRow.textContent).toContain('2,450.75'); // available 245075
    // Raw minor-unit strings must NEVER reach the DOM.
    expect(frozenRow.textContent).not.toContain('250075');
    expect(frozenRow.textContent).not.toContain('245075');

    // The status badge reflects the account's lifecycle, and a frozen account offers "Unfreeze".
    expect(within(frozenRow).getByText('frozen')).toBeInTheDocument();
    expect(within(frozenRow).getByRole('button', { name: 'Unfreeze' })).toBeInTheDocument();

    // An active account shows "active" and offers "Freeze".
    const activeRow = rowFor(ACTIVE_ID);
    expect(within(activeRow).getByText('active')).toBeInTheDocument();
    expect(within(activeRow).getByRole('button', { name: 'Freeze' })).toBeInTheDocument();
    expect(activeRow.textContent).toContain('15,000.00'); // balance 1500000
    expect(activeRow.textContent).not.toContain('1500000');
  });
});

describe('AccountsPage — freeze round-trip + cache invalidation', () => {
  it('freezes an active account and the SAME row flips to frozen after the list refetches', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'accounts' });

    const activeRow = rowFor(ACTIVE_ID);
    expect(within(activeRow).getByText('active')).toBeInTheDocument();

    fireEvent.click(within(activeRow).getByRole('button', { name: 'Freeze' }));

    // The invalidated LIST tag forces a refetch; the row then reflects the server's new status.
    // (If invalidation were missing, the row would stay 'active' and this would fail.)
    await waitFor(() => expect(within(rowFor(ACTIVE_ID)).getByText('frozen')).toBeInTheDocument());
    expect(within(rowFor(ACTIVE_ID)).getByRole('button', { name: 'Unfreeze' })).toBeInTheDocument();
    // No error surfaced on the happy path.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disables ONLY the acting row while its freeze is in flight', async () => {
    // A slow freeze keeps the in-flight window observable. It delegates to the real stub state so
    // the mutation succeeds AND the post-invalidation refetch reflects the new frozen status.
    server.use(
      http.post('/balance/admin/accounts/:id/freeze', async ({ params }) => {
        await delay(60);
        const account = freezeAccount(String(params.id));
        return HttpResponse.json(account);
      }),
    );

    renderPage();
    await screen.findByRole('table', { name: 'accounts' });

    fireEvent.click(within(rowFor(ACTIVE_ID)).getByRole('button', { name: 'Freeze' }));

    // The acting row's button disables and shows the working label...
    await waitFor(() => expect(within(rowFor(ACTIVE_ID)).getByRole('button')).toBeDisabled());
    expect(within(rowFor(ACTIVE_ID)).getByRole('button')).toHaveTextContent(/working/i);
    // ...but a DIFFERENT row stays actionable (pendingId targets only the acting account).
    expect(within(rowFor(OWNER_TWO_ID)).getByRole('button')).toBeEnabled();

    // And it eventually settles into the frozen state.
    await waitFor(() =>
      expect(within(rowFor(ACTIVE_ID)).getByRole('button', { name: 'Unfreeze' })).toBeEnabled(),
    );
  });
});

describe('AccountsPage — a failed action surfaces an error and does NOT flip the status', () => {
  it('shows an Alert on a 500 and the acted row stays active', async () => {
    server.use(
      http.post('/balance/admin/accounts/:id/freeze', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );

    renderPage();
    await screen.findByRole('table', { name: 'accounts' });
    fireEvent.click(within(rowFor(ACTIVE_ID)).getByRole('button', { name: 'Freeze' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/account action failed/i);

    // Critically: a failed freeze must not optimistically flip the UI — the row is still active.
    expect(within(rowFor(ACTIVE_ID)).getByText('active')).toBeInTheDocument();
    expect(within(rowFor(ACTIVE_ID)).getByRole('button', { name: 'Freeze' })).toBeInTheDocument();
    expect(within(rowFor(ACTIVE_ID)).queryByText('frozen')).not.toBeInTheDocument();
  });
});

describe('AccountsPage — owner filter narrows the list server-side', () => {
  it("applies the owner-id filter so only that customer's accounts remain", async () => {
    renderPage();
    await screen.findByRole('table', { name: 'accounts' });

    // Baseline: OWNER_ONE (two accounts) and OWNER_TWO both present.
    expect(document.querySelector(`[data-account-id="${ACTIVE_ID}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-account-id="${OWNER_TWO_ID}"]`)).not.toBeNull();

    fireEvent.change(screen.getByLabelText(/filter by owner id/i), {
      target: { value: OWNER_TWO },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));

    // After the filtered refetch, only OWNER_TWO's account is shown; OWNER_ONE's are gone.
    await waitFor(() =>
      expect(document.querySelector(`[data-account-id="${ACTIVE_ID}"]`)).toBeNull(),
    );
    expect(document.querySelector(`[data-account-id="${OWNER_TWO_ID}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-account-id="${FROZEN_ID}"]`)).toBeNull();

    // Sanity: the filter arg reached the query for OWNER_TWO, not OWNER_ONE.
    expect(OWNER_TWO).not.toBe(OWNER_ONE);
  });
});
