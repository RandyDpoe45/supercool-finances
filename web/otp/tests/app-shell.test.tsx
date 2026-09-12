import { fireEvent, render, screen } from '@testing-library/react';
import { useAuth, type AuthContextProps } from 'react-oidc-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/components/templates/AppShell';

/**
 * AppShell is the authenticated frame (header identity + sign-out) wrapping routed
 * content. The dark restyle rewrote this header — added a brand mark, reflowed the
 * identity span, and moved the bare sign-out button onto the `btn btn--secondary`
 * primitive — which is exactly where a re-nested element silently drops its onClick or
 * a "must stay verbatim" label mutates. We mock OIDC ONLY at the `useAuth` boundary and
 * drive the REAL shell, asserting the sign-out handler and the brand/identity contract.
 */

vi.mock('react-oidc-context', () => ({ useAuth: vi.fn() }));

const mockedUseAuth = vi.mocked(useAuth);
const signoutRedirect = vi.fn(() => Promise.resolve());

function setAuth(state: Partial<AuthContextProps>): void {
  mockedUseAuth.mockReturnValue({
    user: undefined,
    signoutRedirect,
    ...state,
  } as unknown as AuthContextProps);
}

const CHILD = 'ROUTED-CONTENT';

function renderShell(): void {
  render(
    <AppShell>
      <div>{CHILD}</div>
    </AppShell>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('AppShell', () => {
  it('fires signoutRedirect exactly once, and only when Sign out is clicked', () => {
    setAuth({});
    renderShell();

    // Nothing signs out on mount — the redirect must come from the click alone.
    expect(signoutRedirect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    expect(signoutRedirect).toHaveBeenCalledTimes(1);
  });

  it('binds the signed-in subject and keeps the brand string verbatim while framing content', () => {
    setAuth({ user: { profile: { sub: 'otp-user-123' } } as unknown as AuthContextProps['user'] });
    renderShell();

    // Brand copy is a hard-constraint DOM string; the header rewrite must not touch it.
    expect(screen.getByText('SuperCool Finances — OTP')).toBeInTheDocument();
    // The subject is wired from auth.user.profile.sub, not hard-coded or stuck on fallback.
    expect(screen.getByText(/signed in as otp-user-123/)).toBeInTheDocument();
    // The shell still frames the routed content it wraps.
    expect(screen.getByText(CHILD)).toBeInTheDocument();
  });
});
