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
      <div role="alert">
        <p>Sign-in failed: {error.message}</p>
        <button type="button" onClick={() => void signinRedirect()}>
          Try again
        </button>
      </div>
    );
  }

  if (isLoading || !isAuthenticated) {
    return <p>Signing in…</p>;
  }

  return <>{children}</>;
}
