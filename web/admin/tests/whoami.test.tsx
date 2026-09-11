import { configureStore } from '@reduxjs/toolkit';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import type { AuthContextProps } from 'react-oidc-context';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// See bearer.test.ts: make same-origin `/balance/admin` explicit/absolute against the test
// origin for the node fetch, before baseApi (via App/HomePage -> store) captures the env at
// import. MSW resolves its relative handler paths against the same origin, so it matches.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

import { App } from '../src/App';
import { HomePage } from '../src/components/pages/HomePage';
import { baseApi } from '../src/services/api/baseApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';

/**
 * The whoami spine — one focused end-to-end proof that the admin auth shell round-trips.
 *
 * `useAuth` is mocked at its boundary so the gate opens, but the API bearer still comes from the
 * REAL shared UserManager, so a signed-in session -> RTK Query attaches the bearer -> MSW
 * `/balance/admin/whoami` answers -> the Home view renders the gateway-resolved identity. The
 * mocked OIDC subject is deliberately DIFFERENT from the whoami `userId`, so the rendered
 * `admin-user-1` can only have come from the API round trip, not from the token profile. The
 * loading and error branches guard that a failed identity fetch shows an alert and never leaks a
 * (stale/absent) identity into the DOM.
 */

const { authState } = vi.hoisted(() => ({
  authState: { current: undefined as unknown as AuthContextProps },
}));

vi.mock('react-oidc-context', () => ({
  useAuth: () => authState.current,
  AuthProvider: ({ children }: { children?: unknown }) => children,
}));

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

function makeUser(expiresAt: number): User {
  return new User({
    access_token: 'spine-access-token',
    token_type: 'Bearer',
    session_state: null,
    scope: 'openid profile',
    expires_at: expiresAt,
    profile: {
      // Deliberately NOT the whoami userId: the shell shows this OIDC subject; the Home page
      // shows the whoami `userId`. Keeping them distinct proves the identity is fetched.
      sub: 'oidc-subject-xyz',
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

beforeEach(async () => {
  authState.current = {
    isLoading: false,
    isAuthenticated: true,
    error: undefined,
    activeNavigator: undefined,
    user: { profile: { sub: 'oidc-subject-xyz' } },
    signinRedirect: vi.fn(() => Promise.resolve()),
    signoutRedirect: vi.fn(() => Promise.resolve()),
  } as unknown as AuthContextProps;
  await userManager.removeUser();
  window.sessionStorage.clear();
});

afterEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe('admin whoami spine', () => {
  it('renders the gateway-resolved admin identity on the authenticated Home view', async () => {
    await userManager.storeUser(makeUser(NOW_SECONDS() + 3600));

    render(<App />);

    // The identity `userId` reached the DOM only via token -> bearer -> /balance/admin/whoami.
    expect(await screen.findByText('admin-user-1')).toBeInTheDocument();
    // The role from the whoami payload is rendered (the fixture's single `admin` role).
    expect(screen.getByText('admin')).toBeInTheDocument();
    // The authenticated shell is present (the gate opened).
    expect(screen.getByText('SuperCool Finances — Admin')).toBeInTheDocument();
    // No error/loading fallbacks left on screen.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('shows the loading state first, then resolves to the identity', async () => {
    await userManager.storeUser(makeUser(NOW_SECONDS() + 3600));

    render(
      <Provider store={makeStore()}>
        <HomePage />
      </Provider>,
    );

    // The whoami fetch is in flight on the first commit: the loading text must show before data.
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    expect(await screen.findByText('admin-user-1')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('shows an alert (and no identity) when the whoami call fails with a 500', async () => {
    await userManager.storeUser(makeUser(NOW_SECONDS() + 3600));
    server.use(
      http.get('/balance/admin/whoami', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );

    render(
      <Provider store={makeStore()}>
        <HomePage />
      </Provider>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Failed to load your admin identity/);
    expect(alert).toHaveTextContent(/HTTP 500/);
    // A failed identity fetch must not render an identity.
    expect(screen.queryByText('admin-user-1')).not.toBeInTheDocument();
  });

  it('fails closed: with no live token the surface returns 401 and the identity is never shown', async () => {
    // No stored user -> no bearer -> the real handler rejects 401. The UI must degrade to an
    // alert, never render an admin identity for an unauthenticated caller.
    render(
      <Provider store={makeStore()}>
        <HomePage />
      </Provider>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/HTTP 401/);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.queryByText('admin-user-1')).not.toBeInTheDocument();
  });
});
