import { configureStore } from '@reduxjs/toolkit';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's global fetch (node/undici) cannot parse the app's relative `/api` base — a
// browser resolves it against the origin, undici does not. Make the SAME same-origin
// `/api` explicit/absolute against the test origin before baseApi captures the env at
// import, so RTK Query's requests are parseable and still match the MSW handlers
// (which resolve their relative paths against that same origin). This changes nothing
// about what is asserted (the outgoing Authorization header).
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/api`);
});

import { accountsApi } from '../src/services/api/accountsApi';
import { baseApi } from '../src/services/api/baseApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';

/**
 * Bearer attachment on the RTK Query base — the security-relevant seam.
 *
 * We drive the REAL `UserManager` (the single source of truth `prepareHeaders`
 * reads via `getAccessToken`) and assert the ACTUAL `Authorization` header on the
 * outgoing `/api` request, intercepted by MSW. Nothing here mocks the token source,
 * so the tests exercise the real "attach the live session token, but never a stale
 * one" logic. A regression that dropped the bearer, attached a hardcoded value, or
 * leaked an expired token would fail here.
 */

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

function makeUser(accessToken: string, expiresAt: number): User {
  return new User({
    access_token: accessToken,
    token_type: 'Bearer',
    session_state: null,
    scope: 'openid profile',
    expires_at: expiresAt,
    profile: {
      sub: 'user-123',
      iss: 'http://keycloak.localtest.me:8082/realms/supercool',
      aud: 'supercool-api',
      exp: expiresAt,
      iat: NOW_SECONDS(),
    },
  });
}

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

/**
 * Dispatch `getAccounts` through a fresh store and return the `Authorization`
 * header MSW actually saw on the outgoing request. The handler returns 200 for
 * every case so the header is observed regardless of the app's auth decision.
 */
async function capturedAuthHeader(): Promise<string | null> {
  let seen: string | null = null;
  server.use(
    http.get('/api/accounts', ({ request }) => {
      seen = request.headers.get('authorization');
      return HttpResponse.json({ accounts: [] });
    }),
  );
  const store = makeStore();
  await store.dispatch(accountsApi.endpoints.getAccounts.initiate());
  return seen;
}

beforeEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
});

afterEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
});

describe('RTK Query bearer attachment', () => {
  it('attaches the live access token as a bearer when a valid session exists', async () => {
    await userManager.storeUser(makeUser('live-access-token', NOW_SECONDS() + 3600));

    const header = await capturedAuthHeader();

    expect(header).toBe('Bearer live-access-token');
  });

  it('attaches no Authorization header when there is no signed-in user', async () => {
    // No user stored — getAccessToken() must return null.
    const header = await capturedAuthHeader();

    expect(header).toBeNull();
  });

  it('does NOT attach a bearer when the stored token is expired', async () => {
    // A stored-but-expired user must be treated as no token (never send a stale
    // credential): getAccessToken checks `user.expired`.
    await userManager.storeUser(makeUser('stale-access-token', NOW_SECONDS() - 3600));

    const header = await capturedAuthHeader();

    expect(header).toBeNull();
  });
});
