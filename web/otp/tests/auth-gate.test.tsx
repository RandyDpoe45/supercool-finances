import { fireEvent, render, screen } from '@testing-library/react';
import { useAuth, type AuthContextProps } from 'react-oidc-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from '../src/auth/AuthGate';

/**
 * AuthGate is the fail-closed protected-route gate (spec 07 / otp docs): signed-out ->
 * initiate the OIDC redirect and show nothing protected; in-flight -> loading, no
 * redirect, no content; error -> surfaced with retry, no content, and crucially NO
 * auto-redirect loop; authenticated -> the shell renders. We mock OIDC ONLY at the
 * `useAuth` boundary and run the real gate, asserting what actually renders / redirects.
 */

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));

const mockedUseAuth = vi.mocked(useAuth);
const signinRedirect = vi.fn(() => Promise.resolve());

const PROTECTED = 'PROTECTED-CONTENT';

function setAuth(state: Partial<AuthContextProps>): void {
  mockedUseAuth.mockReturnValue({
    isLoading: false,
    isAuthenticated: false,
    error: undefined,
    activeNavigator: undefined,
    signinRedirect,
    ...state,
  } as unknown as AuthContextProps);
}

function renderGate() {
  return render(
    <AuthGate>
      <div>{PROTECTED}</div>
    </AuthGate>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AuthGate', () => {
  it('initiates the sign-in redirect and reveals no protected content when signed out', () => {
    setAuth({ isLoading: false, isAuthenticated: false });
    renderGate();
    expect(signinRedirect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(PROTECTED)).toBeNull();
  });

  it('renders the protected content and does not redirect when authenticated', () => {
    setAuth({ isAuthenticated: true });
    renderGate();
    expect(screen.getByText(PROTECTED)).toBeInTheDocument();
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('shows the loading state without redirecting or leaking content while sign-in is in flight', () => {
    setAuth({ isLoading: true });
    renderGate();
    expect(screen.getByText('Signing in…')).toBeInTheDocument();
    expect(screen.queryByText(PROTECTED)).toBeNull();
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('does not fire a second redirect while one is already active', () => {
    setAuth({ activeNavigator: 'signinRedirect' });
    renderGate();
    expect(signinRedirect).not.toHaveBeenCalled();
    expect(screen.queryByText(PROTECTED)).toBeNull();
  });

  it('surfaces a sign-in error with a retry and does NOT auto-redirect (no loop)', () => {
    const error = Object.assign(new Error('token exchange failed'), {
      source: 'signinRedirect',
      args: undefined,
    });
    setAuth({ error: error as unknown as AuthContextProps['error'] });
    renderGate();

    expect(screen.getByRole('alert')).toHaveTextContent('token exchange failed');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText(PROTECTED)).toBeNull();
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('re-initiates sign-in exactly once when the error-state retry button is clicked, leaking no content', () => {
    const error = Object.assign(new Error('token exchange failed'), {
      source: 'signinRedirect',
      args: undefined,
    });
    setAuth({ error: error as unknown as AuthContextProps['error'] });
    renderGate();

    // The one redirect must come from the click, not an auto-redirect on the error state.
    expect(signinRedirect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(signinRedirect).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(PROTECTED)).toBeNull();
  });
});
