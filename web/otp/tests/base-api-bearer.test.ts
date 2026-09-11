import { configureStore } from '@reduxjs/toolkit';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../src/mocks/node';

/**
 * Bearer attachment on the RTK Query base query (spec 07 auth spine: "Access token
 * attached to API calls"; otp docs: prepareHeaders reads the live token from the SAME
 * shared UserManager). These tests drive the REAL `UserManager` (seed the real user
 * store) and assert the `Authorization` header the server actually receives — not that
 * a function was called.
 *
 * Harness note: Node's global `Request` (used by RTK Query + MSW) cannot resolve the
 * app's relative `/api` base, which is correct for the browser. So we stub
 * `VITE_API_BASE_URL` to the absolute jsdom origin BEFORE importing `baseApi`, then
 * exercise the same prepareHeaders code path. This is a test accommodation, not a
 * production change.
 */

const API_ORIGIN = window.location.origin;

let baseApiMod: typeof import('../src/services/api/baseApi');
let pendingApiMod: typeof import('../src/services/api/pendingAuthorizationApi');
let userManagerMod: typeof import('../src/auth/userManager');

function makeStore() {
  const { baseApi } = baseApiMod;
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

async function dispatchGetPending(): Promise<void> {
  const store = makeStore();
  await store.dispatch(
    pendingApiMod.pendingAuthorizationApi.endpoints.getPendingAuthorization.initiate(),
  );
}

function storeUser(accessToken: string, expiresInSeconds: number): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const user = new User({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_at: nowSeconds + expiresInSeconds,
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

const NOT_CALLED = '__handler-not-called__';
let capturedAuthorization: string | null;

beforeAll(async () => {
  vi.stubEnv('VITE_API_BASE_URL', `${API_ORIGIN}/api`);
  baseApiMod = await import('../src/services/api/baseApi');
  pendingApiMod = await import('../src/services/api/pendingAuthorizationApi');
  userManagerMod = await import('../src/auth/userManager');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  await userManagerMod.userManager.removeUser();
  capturedAuthorization = NOT_CALLED;
  // Capture the header the server sees and always answer 200 so the header-attachment
  // concern is isolated from the 401 identity path (covered elsewhere).
  server.use(
    http.get('/api/pending-authorization', ({ request }) => {
      capturedAuthorization = request.headers.get('authorization');
      return HttpResponse.json({ authorization: null });
    }),
  );
});

afterEach(async () => {
  // Clears the stored user AND cancels the token-renew timers UserManager arms on load,
  // so nothing fires a background Keycloak call into a later test.
  await userManagerMod.userManager.removeUser();
});

describe('baseApi bearer attachment', () => {
  it('attaches the live access token as `Authorization: Bearer <token>` when signed in', async () => {
    await storeUser('access-token-abc', 3600);
    await dispatchGetPending();
    expect(capturedAuthorization).toBe('Bearer access-token-abc');
  });

  it('sends no Authorization header when there is no signed-in user', async () => {
    await dispatchGetPending();
    expect(capturedAuthorization).toBeNull();
  });

  it('sends no Authorization header when the stored token is expired', async () => {
    await storeUser('stale-token', -60);
    await dispatchGetPending();
    expect(capturedAuthorization).toBeNull();
  });
});
