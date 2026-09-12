import { useEffect, type ReactNode } from 'react';
import { useAuth } from 'react-oidc-context';

/**
 * Protected-route gate. Renders children only when authenticated; otherwise it
 * covers the OIDC lifecycle: while the token exchange / silent renew is in flight it
 * shows a loading state (this is also where the post-redirect code exchange
 * completes), on error it offers a retry, and when signed out it kicks off the
 * Authorization Code + PKCE redirect to Keycloak. Fail-closed: nothing protected
 * renders until a live session exists.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { isLoading, isAuthenticated, error, activeNavigator, signinRedirect } = auth;

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !error && !activeNavigator) {
      void signinRedirect();
    }
  }, [isLoading, isAuthenticated, error, activeNavigator, signinRedirect]);

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center bg-base p-6 text-ink">
        <div role="alert" className="alert alert--error grid max-w-md gap-3">
          <p className="m-0">Sign-in failed: {error.message}</p>
          <button
            type="button"
            className="btn btn--primary justify-self-start"
            onClick={() => void signinRedirect()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (isLoading || !isAuthenticated) {
    return (
      <div className="grid min-h-screen place-items-center bg-base p-6 text-ink">
        <p className="text-ink-muted">Signing in…</p>
      </div>
    );
  }

  return <>{children}</>;
}
