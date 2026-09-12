import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';

/**
 * The authenticated app frame: a minimal header (identity + sign-out) wrapping the
 * routed content.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const subject = auth.user?.profile.sub ?? 'account';
  return (
    <div className="min-h-screen bg-base text-ink">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b border-line bg-black/95 px-4 py-3 backdrop-blur sm:px-6">
        <span className="flex items-center gap-2 text-base font-extrabold tracking-tight">
          <span aria-hidden="true" className="inline-block h-5 w-5 rounded-full bg-accent" />
          <strong>SuperCool Finances — OTP</strong>
        </span>
        <span className="ml-auto text-sm text-ink-muted"> — signed in as {subject} </span>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void auth.signoutRedirect()}
        >
          Sign out
        </button>
      </header>
      <main>{children}</main>
    </div>
  );
}
