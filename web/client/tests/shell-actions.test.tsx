import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AuthContextProps } from 'react-oidc-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '../src/auth/AuthGate';
import { AppShell } from '../src/components/templates/AppShell';

/**
 * Shell/gate ACTION buttons the dark+green restyle rewrote — "Sign out" (AppShell)
 * and "Try again" (AuthGate error). Both were restructured by the restyle (the shell
 * button gained a class and moved inside a reflowed header; the retry button was
 * re-nested inside two new wrapper divs). No other suite asserts these two buttons'
 * accessible names OR that clicking them still fires the auth action — so a restyle
 * that dropped an `onClick` while reflowing JSX, or renamed a label, would slip past
 * the existing guard. These tests pin the DoD-protected labels ("Sign out", "Try
 * again" stay verbatim) to their real behavior: the click must reach the OIDC action.
 *
 * The OIDC provider is mocked at the `useAuth` boundary (as in auth-gate.test.tsx);
 * the REAL AuthGate + AppShell render.
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

beforeEach(() => {
  signinRedirect.mockClear();
  signoutRedirect.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('shell + gate action buttons (restyle behavior-preservation)', () => {
  it('keeps the "Sign out" button wired to signoutRedirect after the shell restyle', () => {
    setAuth({
      isAuthenticated: true,
      isLoading: false,
      user: { profile: { sub: 'user-abc' } } as AuthContextProps['user'],
    });

    render(
      <AuthGate>
        <AppShell>
          <p>account dashboard</p>
        </AppShell>
      </AuthGate>,
    );

    // Reachable by its exact accessible name — guards the verbatim "Sign out" label.
    const signOut = screen.getByRole('button', { name: 'Sign out' });
    expect(signoutRedirect).not.toHaveBeenCalled();

    fireEvent.click(signOut);

    // The click must still trigger sign-out — the onClick survived the JSX reflow.
    expect(signoutRedirect).toHaveBeenCalledTimes(1);
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('keeps the error-state "Try again" button wired to signinRedirect after the restyle', async () => {
    setAuth({
      isAuthenticated: false,
      isLoading: false,
      error: Object.assign(new Error('token exchange failed'), { source: 'unknown' as const }),
    });

    render(
      <AuthGate>
        <AppShell>
          <p>account dashboard</p>
        </AppShell>
      </AuthGate>,
    );

    // The error branch must NOT auto-redirect (would loop the user); the button is the
    // only path back — proven by the click below producing exactly one redirect.
    const retry = screen.getByRole('button', { name: 'Try again' });
    await waitFor(() => expect(signinRedirect).not.toHaveBeenCalled());

    fireEvent.click(retry);

    expect(signinRedirect).toHaveBeenCalledTimes(1);
    // Protected content must still never leak from the error state.
    expect(screen.queryByText('account dashboard')).not.toBeInTheDocument();
  });
});
