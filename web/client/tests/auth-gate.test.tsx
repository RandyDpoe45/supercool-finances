import { render, screen, waitFor } from '@testing-library/react';
import type { AuthContextProps } from 'react-oidc-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '../src/auth/AuthGate';
import { AppShell } from '../src/components/templates/AppShell';

/**
 * Auth gating. The OIDC provider state is mocked at its boundary — the `useAuth`
 * hook — while the REAL `AuthGate` (and `AppShell`) run. This proves the security
 * property that authenticated app content is never rendered to an unauthenticated
 * visitor, and that such a visitor is actively driven into the PKCE redirect. A gate
 * that fell open (rendered children before auth resolved) would fail here.
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

function renderGate() {
  return render(
    <AuthGate>
      <AppShell>
        <p>account dashboard</p>
      </AppShell>
    </AuthGate>,
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
  it('drives an unauthenticated visitor into the OIDC sign-in redirect and shows no app content', async () => {
    setAuth({ isAuthenticated: false, isLoading: false });

    renderGate();

    await waitFor(() => expect(signinRedirect).toHaveBeenCalledTimes(1));
    // The protected shell must not be exposed before authentication.
    expect(screen.queryByText('account dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('SuperCool Finances')).not.toBeInTheDocument();
  });

  it('renders the app shell (and does not redirect) for an authenticated user', async () => {
    setAuth({
      isAuthenticated: true,
      isLoading: false,
      user: { profile: { sub: 'user-abc' } } as AuthContextProps['user'],
    });

    renderGate();

    expect(await screen.findByText('account dashboard')).toBeInTheDocument();
    expect(screen.getByText('SuperCool Finances')).toBeInTheDocument();
    expect(screen.getByText(/signed in as user-abc/)).toBeInTheDocument();
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('does not redirect or expose content while the token exchange is in flight', async () => {
    setAuth({ isAuthenticated: false, isLoading: true });

    renderGate();

    expect(screen.getByText('Signing in…')).toBeInTheDocument();
    expect(screen.queryByText('account dashboard')).not.toBeInTheDocument();
    // A loading state is not a signed-out state — do not kick off a second redirect.
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('surfaces a sign-in error with a retry instead of app content', async () => {
    setAuth({
      isAuthenticated: false,
      isLoading: false,
      error: Object.assign(new Error('token exchange failed'), { source: 'unknown' as const }),
    });

    renderGate();

    expect(screen.getByRole('alert')).toHaveTextContent('token exchange failed');
    expect(screen.queryByText('account dashboard')).not.toBeInTheDocument();
    // The error path must not auto-redirect (would trap the user in a loop).
    expect(signinRedirect).not.toHaveBeenCalled();
  });
});
