import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AuthContextProps } from 'react-oidc-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/components/templates/AppShell';
import { AuthGate } from '../src/auth/AuthGate';

/**
 * Shell + gate interaction contract. The visual restyle rewrote `AppShell` (header reflow, brand
 * mark, nav pills) and the `AuthGate` loading/error states, so it could silently drop a nav link,
 * mangle an href, unmount the primary `<nav>`, or sever a bare button's click handler — none of
 * which the DOM-presence checks in auth-gate.test.tsx / whoami.test.tsx would notice. These tests
 * hold the interactive + navigational wiring the restyle put at risk. `useAuth` is mocked at the
 * same boundary the rest of the suite uses; the REAL AppShell / AuthGate run.
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

// The six primary destinations in intended order, each with the router path its <Link> must target.
const NAV = [
  { name: 'Home', href: '/' },
  { name: 'Accounts', href: '/accounts' },
  { name: 'Limits', href: '/limits' },
  { name: 'Reversals', href: '/reversals' },
  { name: 'Audit', href: '/audit' },
  { name: 'Analytics', href: '/analytics' },
] as const;

describe('AppShell primary navigation', () => {
  it('exposes exactly the six primary nav links with their correct hrefs, scoped to nav[aria-label="Primary"]', () => {
    setAuth({
      isAuthenticated: true,
      user: { profile: { sub: 'admin-abc' } } as AuthContextProps['user'],
    });

    render(
      <MemoryRouter>
        <AppShell>
          <p>admin console body</p>
        </AppShell>
      </MemoryRouter>,
    );

    // The accessible name comes from aria-label="Primary": a lost/renamed label fails here.
    const nav = screen.getByRole('navigation', { name: 'Primary' });

    // Every destination must resolve to its own route, and each link must live *inside* the
    // primary nav (a link hoisted out of the nav, or pointing at the wrong route, fails).
    for (const { name, href } of NAV) {
      const link = within(nav).getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
    }

    // Exactly six — no destination silently dropped or duplicated by the pill restyle.
    expect(within(nav).getAllByRole('link')).toHaveLength(NAV.length);
  });
});

describe('AppShell sign out', () => {
  it('fires signoutRedirect exactly once when the Sign out button is clicked (and does not sign in)', () => {
    setAuth({
      isAuthenticated: true,
      user: { profile: { sub: 'admin-abc' } } as AuthContextProps['user'],
    });

    render(
      <MemoryRouter>
        <AppShell>
          <p>admin console body</p>
        </AppShell>
      </MemoryRouter>,
    );

    const signOut = screen.getByRole('button', { name: 'Sign out' });
    // Handler must not fire on render — only on the click.
    expect(signoutRedirect).not.toHaveBeenCalled();

    fireEvent.click(signOut);

    expect(signoutRedirect).toHaveBeenCalledTimes(1);
    expect(signinRedirect).not.toHaveBeenCalled();
  });
});

describe('AuthGate error retry', () => {
  it('retries sign-in exactly once on click, keeps the alert, and never auto-redirects or leaks content', () => {
    setAuth({
      isAuthenticated: false,
      error: Object.assign(new Error('token exchange failed'), { source: 'unknown' as const }),
    });

    render(
      <MemoryRouter>
        <AuthGate>
          <p>admin console body</p>
        </AuthGate>
      </MemoryRouter>,
    );

    // Error path must be fail-closed and NOT auto-redirect (that would trap the user in a loop).
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('token exchange failed');
    expect(screen.queryByText('admin console body')).not.toBeInTheDocument();
    expect(signinRedirect).not.toHaveBeenCalled();

    // The retry is the ONLY way out of the error state; its handler must survive the restyle.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(signinRedirect).toHaveBeenCalledTimes(1);
    // Retrying does not tear the alert down or leak the protected shell.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('admin console body')).not.toBeInTheDocument();
  });
});
