import { expect, test } from '@playwright/test';
import { keycloakLogin } from './fixtures/auth';
import { requirePassword, requireUsername } from './fixtures/env';
import { e2eDescribe } from './fixtures/harness';

/**
 * DoD: "Each app completes PKCE login and calls its API through nginx/Kong." For the
 * client-app this proves the whole authenticated spine end-to-end against the REAL stack:
 * PKCE round-trip to Keycloak -> bearer attached -> `GET /balance/api/accounts` traverses
 * nginx + Kong (JWT verified, identity injected) -> real balances render.
 *
 * PENDING until spec 08 (see tests/e2e/README.md): running docker-compose stack + seeded
 * accounts + a Keycloak `customer` login.
 */
e2eDescribe('client-app · PKCE login and authenticated accounts read', () => {
  test('logs in through Keycloak and renders real balances from GET /balance/api/accounts', async ({
    page,
  }) => {
    // Capture the real accounts response as the app fetches it, so we can tie the rendered
    // DOM back to the exact wire payload that came through Kong (not a stub).
    const accountsResponse = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return pathname.endsWith('/balance/api/accounts') && response.request().method() === 'GET';
    });

    await keycloakLogin(page, {
      entryPath: '/',
      username: requireUsername(),
      password: requirePassword(),
    });

    // The overview is the authenticated landing page.
    await expect(page.getByRole('heading', { name: 'Your accounts', level: 1 })).toBeVisible();

    const response = await accountsResponse;
    // The gateway let the call through only because a verified customer bearer was attached.
    expect(response.status()).toBe(200);
    const authHeader = response.request().headers()['authorization'];
    expect(authHeader).toMatch(/^Bearer .+/);

    const body = (await response.json()) as {
      accounts: Array<{ id: string; accountNumber: string | null }>;
    };
    expect(body.accounts.length).toBeGreaterThan(0);

    // The rendered list must reflect the real payload: it is a semantic list, and the first
    // account's number (rendered verbatim as the card's link) must appear in the DOM. This
    // ties the view to real data without reconstructing locale money formatting.
    const list = page.getByRole('list', { name: 'accounts' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(body.accounts.length);

    const first = body.accounts[0];
    const firstLabel = first.accountNumber ?? first.id;
    await expect(page.getByText(firstLabel, { exact: false })).toBeVisible();

    // Each card exposes the three money fields the customer relies on.
    await expect(page.getByText('Balance', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Held', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Available', { exact: true }).first()).toBeVisible();
  });
});
