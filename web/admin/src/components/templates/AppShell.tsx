import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { Link } from 'react-router-dom';

/**
 * The authenticated admin frame: a header (title + primary nav + sign-out) wrapping the
 * routed content. Navigation uses router `<Link>`s (the app is root-served). Nav covers Home,
 * account management (Accounts), Limits, maker-checker Reversals, the read-only Audit log, and the
 * Analytics dashboard.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const subject = auth.user?.profile.sub ?? 'admin';
  return (
    <div className="min-h-screen bg-base text-ink">
      <header className="app-header sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b border-line bg-black/95 px-4 py-3 backdrop-blur sm:px-6">
        <span className="flex items-center gap-2">
          <span className="inline-block h-5 w-5 rounded-full bg-accent" aria-hidden="true" />
          <strong className="text-base font-extrabold tracking-tight">
            SuperCool Finances — Admin
          </strong>
        </span>
        <nav className="app-nav" aria-label="Primary">
          <Link to="/">Home</Link>
          <Link to="/accounts">Accounts</Link>
          <Link to="/limits">Limits</Link>
          <Link to="/reversals">Reversals</Link>
          <Link to="/audit">Audit</Link>
          <Link to="/analytics">Analytics</Link>
        </nav>
        <span className="app-header__identity"> — signed in as {subject} </span>
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
