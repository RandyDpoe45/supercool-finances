import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetMockState, setMockPending } from '../src/mocks/state';
import { server } from '../src/mocks/node';
import type { PendingAuthorizationDto } from '../src/services/api/contracts/pending-authorization';

/**
 * End-to-end spine: a signed-in user's live token flows through the RTK Query bearer to
 * `GET /balance/api/pending-authorization` (live MSW) and the REAL HomePage renders the pending card
 * (composed of the real feed + reveal panel), then re-fetches on demand. This exercises the
 * real component + store + base query + UserManager together, so it fails if the bearer is not
 * attached, the `{ authorization }` envelope is not unwrapped, the money/datetime helpers are
 * not applied, or the empty/refetch behaviour is wrong.
 *
 * Harness note: `VITE_API_BASE_URL` is stubbed to the absolute jsdom origin before the app
 * modules load — see base-api-bearer.test.ts for why (Node cannot fetch a relative base). This
 * is a test accommodation, not a production change.
 */

const API_ORIGIN = window.location.origin;

let baseApiMod: typeof import('../src/services/api/baseApi');
let homePageMod: typeof import('../src/components/pages/HomePage');
let userManagerMod: typeof import('../src/auth/userManager');

// A controlled internal pending: fixed createdAt (so the Mexico City conversion is
// deterministic) + a future expiresAt (so a live countdown is present and > 0).
const CONTROLLED_INTERNAL: PendingAuthorizationDto = {
  transferId: '33333333-3333-4333-8333-333333333333',
  type: 'internal',
  amount: '125000', // $1,250.00
  currency: 'MXN',
  sourceAccountId: '11111111-1111-4111-8111-111111111111',
  destinationAccountNumber: '1000000002',
  destinationMaskedName: 'Jua** Per**',
  payeeDisplayName: null,
  createdAt: '2026-09-10T18:00:00Z',
  expiresAt: new Date(Date.now() + 90_000).toISOString(),
};

function makeStore() {
  const { baseApi } = baseApiMod;
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function renderHome() {
  const { HomePage } = homePageMod;
  return render(
    <Provider store={makeStore()}>
      <HomePage />
    </Provider>,
  );
}

function signIn(): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const user = new User({
    access_token: 'live-access-token',
    token_type: 'Bearer',
    expires_at: nowSeconds + 3600,
    profile: {
      sub: 'otp-user',
      iss: 'issuer',
      aud: 'otp-app',
      exp: nowSeconds + 3600,
      iat: nowSeconds,
    },
  });
  return userManagerMod.userManager.storeUser(user);
}

beforeAll(async () => {
  vi.stubEnv('VITE_API_BASE_URL', `${API_ORIGIN}/balance/api`);
  baseApiMod = await import('../src/services/api/baseApi');
  homePageMod = await import('../src/components/pages/HomePage');
  userManagerMod = await import('../src/auth/userManager');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(async () => {
  await userManagerMod.userManager.removeUser();
  resetMockState();
});

describe('HomePage spine (token -> bearer -> /balance/api -> render)', () => {
  it('renders the real pending card for a seeded internal authorization', async () => {
    await signIn();
    server.use(
      http.get('/balance/api/pending-authorization', () =>
        HttpResponse.json({ authorization: CONTROLLED_INTERNAL }),
      ),
    );
    renderHome();

    // Formatted amount + currency (raw minor units never leak).
    expect(await screen.findByText('$1,250.00 MXN')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('125000');

    // Type-dependent destination for an internal transfer.
    expect(screen.getByText('1000000002')).toBeInTheDocument();
    expect(screen.getByText('Jua** Per**')).toBeInTheDocument();
    expect(screen.queryByText('Payee')).toBeNull();

    // Requested time is converted to Mexico City wall-clock, not left in UTC.
    expect(document.body.textContent).toContain('12:00:00');
    expect(document.body.textContent).toContain('GMT-6');
    expect(document.body.textContent).not.toContain('06:00:00');

    // A live expiry countdown is present.
    expect(screen.getByText(/^\d{1,2}:\d{2}$/)).toBeInTheDocument();
  });

  it('shows the empty state and withholds reveal when the API returns { authorization: null }', async () => {
    await signIn();
    server.use(
      http.get('/balance/api/pending-authorization', () =>
        HttpResponse.json({ authorization: null }),
      ),
    );
    renderHome();

    expect(await screen.findByText(/No pending authorization right now/i)).toBeInTheDocument();
    // Reveal is withheld with a reason; there is no reveal action and no amount.
    expect(
      screen.getByText(/There is no pending authorization, so there is nothing to authorize/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('reveal-code')).toBeNull();
    expect(document.body.textContent).not.toContain('$');
  });

  it('refetches from the server when Refresh is pressed (card -> empty state)', async () => {
    await signIn();
    // Start from the default seeded internal pending.
    renderHome();
    expect(await screen.findByText('$1,250.00 MXN')).toBeInTheDocument();

    // The pending is authorized/cleared server-side; a refresh must reflect that.
    setMockPending(null);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(await screen.findByText(/No pending authorization right now/i)).toBeInTheDocument();
    expect(screen.queryByText('$1,250.00 MXN')).toBeNull();
  });
});
