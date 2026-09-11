import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';

/**
 * The authenticated app frame: a minimal header (identity + sign-out) wrapping the
 * routed content. Real navigation and styling arrive with the O2 pending-feed UI.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const subject = auth.user?.profile.sub ?? 'account';
  return (
    <div>
      <header>
        <strong>SuperCool Finances — OTP</strong>
        <span> — signed in as {subject} </span>
        <button type="button" onClick={() => void auth.signoutRedirect()}>
          Sign out
        </button>
      </header>
      <main>{children}</main>
    </div>
  );
}
