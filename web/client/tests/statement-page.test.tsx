import { configureStore } from '@reduxjs/toolkit';
import { render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's node fetch cannot resolve the app's relative `/api` base; make the SAME
// same-origin base absolute against the test origin before baseApi captures the env at
// import (identical to bearer/spine tests). MSW resolves its relative handlers against
// the same origin, so requests still match.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/api`);
});

// Importing the page also registers accountsApi's injected endpoints on baseApi.
import { AccountStatementPage } from '../src/components/pages/AccountStatementPage';
import { baseApi } from '../src/services/api/baseApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import { fixtureStatements } from '../src/mocks/fixtures/statements';

/**
 * The statement page over a fresh store + live MSW + a REAL signed-in session (so the RTK
 * Query bearer is attached exactly as in production). These prove the whole read path:
 * route id -> query -> stub -> newest-first render with float-free amounts and Mexico City
 * timestamps -> empty and not-found states. Nothing here mocks the query or the formatters.
 */

const OWNED_ID = '11111111-1111-4111-8111-111111111111';
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

function makeStore() {
  // Fresh store per render so RTK Query's cache never bleeds across tests.
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function renderStatement(accountId: string) {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[`/accounts/${accountId}/transactions`]}>
        <Routes>
          <Route path="/accounts/:id/transactions" element={<AccountStatementPage />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

beforeEach(async () => {
  await userManager.storeUser(
    new User({
      access_token: 'statement-access-token',
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
});

describe('AccountStatementPage — happy path', () => {
  it('renders the fixture legs newest-first with float-free amounts and Mexico City timestamps', async () => {
    renderStatement(OWNED_ID);

    const table = await screen.findByRole('table', { name: 'statement' });
    const rows = within(table).getAllByRole('row');
    // 1 header row + one row per fixture entry.
    const expected = fixtureStatements[OWNED_ID];
    expect(rows).toHaveLength(expected.length + 1);

    const dataRows = rows.slice(1);
    // Newest-first ordering flows to the DOM: first data row = newest txn, last = oldest.
    expect(dataRows[0].textContent).toContain('b1000004-0000-4000-8000-000000000004');
    expect(dataRows[dataRows.length - 1].textContent).toContain(
      'b1000001-0000-4000-8000-000000000001',
    );

    // Direction labels derived from the sign of delta.
    expect(within(table).getAllByText('Debit').length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Credit').length).toBeGreaterThan(0);

    // Float-free formatted amounts (hand-computed): a debit, a signed credit, a balanceAfter.
    expect(table.textContent).toContain('-500.00 MXN'); // delta -50000
    expect(table.textContent).toContain('+1,500.00 MXN'); // delta 150000, credit gets '+'
    expect(table.textContent).toContain('15,000.00 MXN'); // balanceAfter 1500000

    // Raw minor units must NEVER reach the DOM.
    expect(table.textContent).not.toContain('-50000');
    expect(table.textContent).not.toContain('1500000');

    // The canonical UTC instant is preserved in <time dateTime>, and the visible text is the
    // Mexico City rendering (16:10:03 for 22:10:03Z), not the raw UTC hour.
    const firstTime = dataRows[0].querySelector('time');
    expect(firstTime?.getAttribute('dateTime')).toBe('2026-09-08T22:10:03.000Z');
    expect(firstTime?.textContent).toContain('16:10:03');
    expect(firstTime?.textContent).not.toContain('22:10:03');
  });
});

describe('AccountStatementPage — empty state', () => {
  it('shows a sensible empty state (no table) when the account has no legs', async () => {
    const emptyId = '44444444-4444-4444-8444-444444444444';
    server.use(
      http.get('/api/accounts/:id/transactions', () =>
        HttpResponse.json({ accountId: emptyId, entries: [] }),
      ),
    );

    renderStatement(emptyId);

    expect(await screen.findByText('No transactions yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('AccountStatementPage — not found', () => {
  it('surfaces a 404 as a plain "not found" without revealing whether the account exists', async () => {
    const unknownId = '99999999-9999-4999-8999-999999999999';
    renderStatement(unknownId);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('not found');
    // No statement data is shown for a non-owned/unknown account.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
