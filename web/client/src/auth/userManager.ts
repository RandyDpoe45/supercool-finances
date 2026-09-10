import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import type { UserManagerSettings } from 'oidc-client-ts';

const AUTHORITY_DEFAULT = 'http://keycloak.localtest.me:8082/realms/supercool';
const CLIENT_ID_DEFAULT = 'client-app';

const authority = import.meta.env.VITE_OIDC_AUTHORITY ?? AUTHORITY_DEFAULT;
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID ?? CLIENT_ID_DEFAULT;
const origin = window.location.origin;

/**
 * OIDC settings for the customer SPA: Authorization Code + PKCE (S256) against the
 * Keycloak `client-app` public client. `redirect_uri`/`post_logout_redirect_uri` are
 * the app origin, which matches the realm's allowlisted `http://localhost:8080/*`
 * in dev. The `supercool-api` audience is added by a Keycloak mapper, so it is NOT
 * requested as a scope here — only `openid profile`.
 */
export const oidcSettings: UserManagerSettings = {
  authority,
  client_id: clientId,
  redirect_uri: `${origin}/`,
  post_logout_redirect_uri: `${origin}/`,
  response_type: 'code',
  scope: 'openid profile',
  automaticSilentRenew: true,
  // Persist the user in sessionStorage so the session survives the full-page
  // redirect back from Keycloak within the same tab.
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
};

/**
 * The single UserManager instance. The `<AuthProvider>` drives it (login, silent
 * renew, logout) and the RTK Query base query reads the live access token from it —
 * one source of truth, so the bearer attached to `/api` calls always reflects the
 * current session.
 */
export const userManager = new UserManager(oidcSettings);

/**
 * Current access token, or null when signed out / expired. Read passively (no
 * renewal side effects) so it is safe to call from `prepareHeaders` on every request.
 */
export async function getAccessToken(): Promise<string | null> {
  const user = await userManager.getUser();
  if (!user || user.expired) {
    return null;
  }
  return user.access_token;
}
