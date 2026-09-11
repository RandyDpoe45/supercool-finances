import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AuthContextProps } from 'react-oidc-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '../src/auth/AuthGate';
import { AppShell } from '../src/components/templates/AppShell';

/**
 * Auth gating (fail-closed). The OIDC provider state is mocked at its boundary — the `useAuth`
 * hook — while the REAL `AuthGate` (and `AppShell`) run. This proves the security property that
 * protected admin content is never rendered to an unauthenticated visitor, and that such a
 * visitor is actively driven into the PKCE redirect exactly once. A gate that fell open
 * (rendered children before auth resolved) or that looped the redirect would fail here.
 */

const { authState } = vi.hoisted(() => ({
  authState: { current: undefined as unknown as AuthContextProps },
}));

vi.mock('react-oidc-context', () => ({
  useAuth: () => authState.current,
  AuthProvider: ({ children }: { children?: unknown }) => children,
}));

const signinRedirect = vi.fn(() => Promise.resolve());
const signoutRedirect = vi.fn(() => Promise.resolve());

function setAuth(overrides: Partial<AuthContextProps>): void {
  authState.current = {
    isLoading: false,
    isAuthenticated: false,
    error: undefined,
    activeNavigator: undefined,
    user: undefined,
    signinRedirect,
    signoutRedirect,
    ...overrides,
  } as unknown as AuthContextProps;
}

// AppShell renders router `<Link>`s, so the gate is wrapped in a router for the authenticated case.
function renderGate() {
  return render(
    <MemoryRouter>
      <AuthGate>
        <AppShell>
          <p>admin console body</p>
        </AppShell>
      </AuthGate>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  signinRedirect.mockClear();
  signoutRedirect.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AuthGate', () => {
  it('drives an unauthenticated visitor into the OIDC sign-in redirect and shows no admin content', async () => {
    setAuth({ isAuthenticated: false, isLoading: false });

    renderGate();

    await waitFor(() => expect(signinRedirect).toHaveBeenCalledTimes(1));
    // The protected shell must not be exposed before authentication.
    expect(screen.queryByText('admin console body')).not.toBeInTheDocument();
    expect(screen.queryByText('SuperCool Finances — Admin')).not.toBeInTheDocument();
  });

  it('renders the app shell (and does not redirect) for an authenticated admin', async () => {
    setAuth({
      isAuthenticated: true,
      isLoading: false,
      user: { profile: { sub: 'admin-abc' } } as AuthContextProps['user'],
    });

    renderGate();

    expect(await screen.findByText('admin console body')).toBeInTheDocument();
    expect(screen.getByText('SuperCool Finances — Admin')).toBeInTheDocument();
    expect(screen.getByText(/signed in as admin-abc/)).toBeInTheDocument();
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('does not redirect or expose content while the token exchange is in flight', async () => {
    setAuth({ isAuthenticated: false, isLoading: true });

    renderGate();

    expect(screen.getByText('Signing in…')).toBeInTheDocument();
    expect(screen.queryByText('admin console body')).not.toBeInTheDocument();
    // A loading state is not a signed-out state — do not kick off a redirect.
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('does not fire a second redirect while one is already active (no redirect loop)', async () => {
    // A redirect already in flight (`activeNavigator` set) is not a signed-out state; the gate
    // must wait it out, not queue another signinRedirect. Removing the `!activeNavigator` guard
    // would fail here.
    setAuth({
      isAuthenticated: false,
      isLoading: false,
      activeNavigator: 'signinRedirect',
    });

    renderGate();

    expect(screen.getByText('Signing in…')).toBeInTheDocument();
    expect(screen.queryByText('admin console body')).not.toBeInTheDocument();
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('surfaces a sign-in error with a retry instead of admin content, and does not auto-redirect', async () => {
    setAuth({
      isAuthenticated: false,
      isLoading: false,
      error: Object.assign(new Error('token exchange failed'), { source: 'unknown' as const }),
    });

    renderGate();

    expect(screen.getByRole('alert')).toHaveTextContent('token exchange failed');
    expect(screen.queryByText('admin console body')).not.toBeInTheDocument();
    // The error path must not auto-redirect (would trap the user in a loop).
    expect(signinRedirect).not.toHaveBeenCalled();
  });
});
