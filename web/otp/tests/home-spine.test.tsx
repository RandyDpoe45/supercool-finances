import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '../src/mocks/node';

/**
 * End-to-end spine (otp docs "Data spine"): a signed-in user's live token flows through
 * the RTK Query bearer to `GET /api/pending-authorization` (live MSW) and the home view
 * renders the presence/absence indicator. This exercises the REAL component + store +
 * base query + UserManager together, so it fails if the bearer is not attached, the
 * `{ authorization }` envelope is not unwrapped, or the indicator logic is wrong.
 *
 * Harness note: `VITE_API_BASE_URL` is stubbed to the absolute jsdom origin before the
 * app modules load — see base-api-bearer.test.ts for why (Node cannot fetch a relative
 * base). This is a test accommodation, not a production change.
 */

const API_ORIGIN = window.location.origin;

let baseApiMod: typeof import('../src/services/api/baseApi');
let homePageMod: typeof import('../src/components/pages/HomePage');
let userManagerMod: typeof import('../src/auth/userManager');

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
  vi.stubEnv('VITE_API_BASE_URL', `${API_ORIGIN}/api`);
  baseApiMod = await import('../src/services/api/baseApi');
  homePageMod = await import('../src/components/pages/HomePage');
  userManagerMod = await import('../src/auth/userManager');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(async () => {
  await userManagerMod.userManager.removeUser();
});

describe('HomePage spine (token -> bearer -> /api -> render)', () => {
  it('shows the pending indicator for the seeded pending authorization', async () => {
    await signIn();
    renderHome();
    expect(await screen.findByText('1 pending authorization')).toBeInTheDocument();
  });

  it('shows the no-pending state when the API returns { authorization: null }', async () => {
    await signIn();
    server.use(
      http.get('/api/pending-authorization', () => HttpResponse.json({ authorization: null })),
    );
    renderHome();
    expect(await screen.findByText('No pending authorizations')).toBeInTheDocument();
  });
});
