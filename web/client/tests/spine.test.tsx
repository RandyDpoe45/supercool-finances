import { render, screen, within } from '@testing-library/react';
import { User } from 'oidc-client-ts';
import type { AuthContextProps } from 'react-oidc-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// See bearer.test.ts: make same-origin `/balance/api` explicit/absolute against the test
// origin for the node fetch, before baseApi (via App → store) captures the env at
// import. MSW resolves its relative handler paths against the same origin, so it matches.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/api`);
});

import { App } from '../src/App';
import { userManager } from '../src/auth/userManager';
import { fixtureAccounts } from '../src/mocks/fixtures/accounts';

/**
 * End-to-end spine (happy path). One focused proof that the whole pipe works:
 * a signed-in session (real access token in the shared UserManager) → RTK Query
 * attaches the bearer → MSW `/balance/api/accounts` stub answers → the home view renders the
 * accounts. The OIDC provider state is mocked at the `useAuth` boundary so the gate
 * opens, but the API bearer still comes from the REAL token source — so a broken
 * bearer would surface as the 401 error view instead of the accounts, failing here.
 */

const { authState } = vi.hoisted(() => ({
  authState: { current: undefined as unknown as AuthContextProps },
}));

vi.mock('react-oidc-context', () => ({
  useAuth: () => authState.current,
  AuthProvider: ({ children }: { children?: unknown }) => children,
}));

// Hand-computed formatted `available` per fixture account (minor units → grouped major,
// MXN exponent 2). Derived by hand — NOT from lib/money — so this spine proof also catches
// a formatter that leaked raw minor units to the DOM. Account 1: '1500000' -> '15,000.00';
// account 2: '245075' -> '2,450.75'.
const EXPECTED_FORMATTED_AVAILABLE: Record<string, string> = {
  '11111111-1111-4111-8111-111111111111': '15,000.00',
  '22222222-2222-4222-8222-222222222222': '2,450.75',
};

function makeUser(expiresAt: number): User {
  return new User({
    access_token: 'spine-access-token',
    token_type: 'Bearer',
    session_state: null,
    scope: 'openid profile',
    expires_at: expiresAt,
    profile: {
      sub: 'user-abc',
      iss: 'http://keycloak.localtest.me:8082/realms/supercool',
      aud: 'supercool-api',
      exp: expiresAt,
      iat: Math.floor(Date.now() / 1000),
    },
  });
}

beforeEach(async () => {
  authState.current = {
    isLoading: false,
    isAuthenticated: true,
    error: undefined,
    activeNavigator: undefined,
    user: { profile: { sub: 'user-abc' } },
    signinRedirect: vi.fn(() => Promise.resolve()),
    signoutRedirect: vi.fn(() => Promise.resolve()),
  } as unknown as AuthContextProps;
  await userManager.storeUser(makeUser(Math.floor(Date.now() / 1000) + 3600));
});

afterEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe('client-app spine', () => {
  it('renders the accounts from the stub on the authenticated home view', async () => {
    render(<App />);

    const list = await screen.findByRole('list', { name: 'accounts' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(fixtureAccounts.length);

    // Every stub account reaches the DOM with its identifier, its FORMATTED available, and
    // currency — proving token → bearer → /balance/api/accounts → transform → render end to end.
    // F2 formats money at the edge, so the DOM shows the grouped human amount, and the raw
    // minor-unit string must NOT be present (raw units must never be visible/SR text).
    for (const account of fixtureAccounts) {
      const line = items.find((item) =>
        item.textContent?.includes(account.accountNumber ?? account.id),
      );
      expect(line, `account ${account.id} should be rendered`).toBeDefined();
      expect(line?.textContent).toContain(EXPECTED_FORMATTED_AVAILABLE[account.id]);
      expect(line?.textContent).not.toContain(account.available);
      expect(line?.textContent).toContain(account.currency);
    }

    // No error/loading fallbacks left on screen.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading accounts…')).not.toBeInTheDocument();
  });
});
