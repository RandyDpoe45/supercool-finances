import type { ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';
import { Link } from 'react-router-dom';

/**
 * The authenticated admin frame: a header (title + primary nav + sign-out) wrapping the
 * routed content. Navigation uses router `<Link>`s (the app is root-served). Nav targets
 * are the Step-1 routes; account-management / reversals / audit links are added as those
 * screens land.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const subject = auth.user?.profile.sub ?? 'admin';
  return (
    <div>
      <header className="app-header">
        <strong>SuperCool Finances — Admin</strong>
        <nav className="app-nav" aria-label="Primary">
          <Link to="/">Home</Link>
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
