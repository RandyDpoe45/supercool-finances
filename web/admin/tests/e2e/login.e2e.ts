import { expect, test } from '@playwright/test';
import { keycloakLogin } from './fixtures/auth';
import { requirePassword, requireUsername } from './fixtures/env';
import { e2eDescribe } from './fixtures/harness';

/**
 * DoD: "Each app completes PKCE login and calls its API through nginx/Kong." For the admin-app
 * this proves the whole authenticated auth-shell spine end-to-end against the REAL stack: PKCE
 * round-trip to Keycloak -> bearer attached -> `GET /balance/admin/whoami` traverses
 * internal-nginx + Kong (JWT verified, `admin` role enforced, identity injected) -> the
 * gateway-resolved admin identity renders on Home.
 *
 * PENDING until spec 08 (see tests/e2e/README.md): running docker-compose stack + a Keycloak
 * login user carrying the `admin` realm role.
 */
e2eDescribe('admin-app · PKCE login and authenticated whoami', () => {
  test('logs in through Keycloak and renders the admin identity from GET /balance/admin/whoami', async ({
    page,
  }) => {
    // Capture the real whoami response as the app fetches it, so we can tie the rendered DOM
    // back to the exact wire payload that came through Kong (not a stub).
    const whoamiResponse = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return pathname.endsWith('/balance/admin/whoami') && response.request().method() === 'GET';
    });

    await keycloakLogin(page, {
      entryPath: '/',
      username: requireUsername(),
      password: requirePassword(),
    });

    // The whoami landing is the authenticated home page.
    await expect(page.getByRole('heading', { name: 'Admin console', level: 1 })).toBeVisible();

    const response = await whoamiResponse;
    // The gateway let the call through only because a verified admin bearer was attached.
    expect(response.status()).toBe(200);
    const authHeader = response.request().headers()['authorization'];
    expect(authHeader).toMatch(/^Bearer .+/);

    const body = (await response.json()) as { userId: string; roles: string[] };
    expect(typeof body.userId).toBe('string');
    expect(body.userId.length).toBeGreaterThan(0);
    // The gateway must resolve this session as an admin (the admin plane is admin-only).
    expect(body.roles).toContain('admin');

    // The rendered view must reflect the real payload: the resolved userId and the admin role.
    // Match exactly: the Home identity `<dd>` is exactly the userId, whereas the AppShell header
    // renders "— signed in as {userId}" (also contains the userId) — an inexact match would hit
    // both and trip Playwright strict mode. Exact pins it to the identity value row.
    await expect(page.getByText(body.userId, { exact: true })).toBeVisible();
    await expect(page.getByText('admin', { exact: true })).toBeVisible();
  });
});
