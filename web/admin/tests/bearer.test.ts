import { configureStore } from '@reduxjs/toolkit';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's global fetch (node/undici) cannot parse the app's relative `/balance/admin` base — a
// browser resolves it against the origin, undici does not. Make the SAME same-origin
// `/balance/admin` explicit/absolute against the test origin before baseApi captures the env at
// import, so RTK Query's requests are parseable and still match the MSW handlers (which resolve
// their relative paths against that same origin). This changes nothing about what is asserted
// (the outgoing Authorization header).
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

import { baseApi } from '../src/services/api/baseApi';
import { identityApi } from '../src/services/api/identityApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';

/**
 * Bearer attachment on the RTK Query base — the security-relevant seam.
 *
 * We drive the REAL `UserManager` (the single source of truth `prepareHeaders` reads via
 * `getAccessToken`) and assert the ACTUAL `Authorization` header on the outgoing
 * `/balance/admin/whoami` request, intercepted by MSW. Nothing here mocks the token source, so
 * the tests exercise the real "attach the live session token, but never a stale one" logic. The
 * capture handler mirrors the gateway contract (bearer -> 200, none -> 401) so each case also
 * proves the fail-closed status: no live token means no header AND the admin surface rejects the
 * call. A regression that dropped the bearer, hardcoded a value, or leaked an expired token
 * would fail here.
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
      sub: 'admin-subject-123',
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

interface DispatchOutcome {
  header: string | null;
  status: number | undefined;
  hasData: boolean;
}

/**
 * Dispatch `getWhoami` through a fresh store and report both the `Authorization` header MSW saw
 * and the effective HTTP status. The capture handler mirrors the real admin gateway guard
 * (bearer required) so a missing header surfaces as the same 401 the service would return.
 */
async function dispatchWhoami(): Promise<DispatchOutcome> {
  let seen: string | null = null;
  server.use(
    http.get('/balance/admin/whoami', ({ request }) => {
      seen = request.headers.get('authorization');
      if (seen === null || !seen.toLowerCase().startsWith('bearer ')) {
        return HttpResponse.json(
          { error: { code: 'UNAUTHORIZED', message: 'Missing gateway identity', requestId: 'r' } },
          { status: 401 },
        );
      }
      return HttpResponse.json({ userId: 'admin-user-1', roles: ['admin'] });
    }),
  );
  const store = makeStore();
  const result = await store.dispatch(identityApi.endpoints.getWhoami.initiate());
  const errorStatus = (result.error as { status?: number } | undefined)?.status;
  return { header: seen, status: errorStatus, hasData: result.data !== undefined };
}

beforeEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
});

afterEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
});

describe('RTK Query bearer attachment (admin surface)', () => {
  it('attaches the live access token as a bearer when a valid session exists', async () => {
    await userManager.storeUser(makeUser('live-access-token', NOW_SECONDS() + 3600));

    const { header, hasData } = await dispatchWhoami();

    expect(header).toBe('Bearer live-access-token');
    // With a credential the admin surface answers — the round trip succeeds.
    expect(hasData).toBe(true);
  });

  it('sends no Authorization header when there is no signed-in user, and the surface rejects 401', async () => {
    // No user stored — getAccessToken() must return null, so nothing authenticates the call.
    const { header, status } = await dispatchWhoami();

    expect(header).toBeNull();
    expect(status).toBe(401);
  });

  it('does NOT attach a bearer when the stored token is expired (never a stale credential)', async () => {
    // A stored-but-expired user must be treated as no token: getAccessToken checks `user.expired`.
    // Sending the stale token would be a security defect, so the surface must see no header -> 401.
    await userManager.storeUser(makeUser('stale-access-token', NOW_SECONDS() - 3600));

    const { header, status } = await dispatchWhoami();

    expect(header).toBeNull();
    expect(status).toBe(401);
  });
});
