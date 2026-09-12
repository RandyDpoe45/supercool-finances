import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';

/**
 * The authenticated app frame: a minimal header (identity + sign-out) wrapping the routed
 * content. Kept router-free (navigation entry points live on the pages, which always render inside
 * the router) so the frame stays trivially testable in isolation.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const subject = auth.user?.profile.sub ?? 'account';
  return (
    <div className="min-h-screen bg-base text-ink">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b border-line bg-black/95 px-4 py-3 backdrop-blur sm:px-6">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="inline-block h-5 w-5 rounded-full bg-accent" />
          <strong className="text-base font-extrabold tracking-tight">SuperCool Finances</strong>
        </span>
        <span className="ml-auto text-sm text-ink-muted"> — signed in as {subject} </span>
        <button
          type="button"
          className="button--secondary"
          onClick={() => void auth.signoutRedirect()}
        >
          Sign out
        </button>
      </header>
      <main>{children}</main>
    </div>
  );
}
