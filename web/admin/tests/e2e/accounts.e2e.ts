import { expect, test } from '@playwright/test';
import { keycloakLogin } from './fixtures/auth';
import { requirePassword, requireUsername } from './fixtures/env';
import { e2eDescribe } from './fixtures/harness';

/**
 * Account-management surface (Step A2) end-to-end against the REAL stack: browser ->
 * internal-nginx -> Kong (JWT verify, `admin` role enforced, identity injected) -> the
 * balance-service admin surface. This proves the account-management and limits SCREENS are
 * reachable on the internal plane and that their reads (`GET /balance/admin/accounts`,
 * `GET /balance/admin/limits`) traverse the gateway with an admin bearer and render.
 *
 * Scope note: this is a READ smoke on purpose. The freeze/unfreeze and PUT-limits MUTATION flow is
 * intentionally deferred to spec 08, when seed data exists and the full stack is run — mutating a
 * shared seeded account/limit from a smoke test would risk interfering with the transfer-with-OTP
 * e2e that spec 08 enables. A mutating flow added here now would be hollow (no seed to assert
 * against) or unsafe (cross-test money-state side effects).
 *
 * PENDING until spec 08 (see tests/e2e/README.md): running docker-compose stack + a Keycloak login
 * user carrying the `admin` realm role. `describe.fixme` registers the spec so
 * `npx playwright test --list` enumerates it without a running stack or installed browsers.
 */
e2eDescribe('admin-app · account-management surface through the gateway', () => {
  test('renders the accounts table from GET /balance/admin/accounts (admin bearer through Kong)', async ({
    page,
  }) => {
    // The app returns to `/` after PKCE (no deep-link restoration), so log in at the root landing,
    // then open the screen via the primary nav — the read fires on that client-side navigation.
    await keycloakLogin(page, {
      entryPath: '/',
      username: requireUsername(),
      password: requirePassword(),
    });
    await expect(page.getByRole('heading', { name: 'Admin console', level: 1 })).toBeVisible();

    const accountsResponse = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return pathname.endsWith('/balance/admin/accounts') && response.request().method() === 'GET';
    });

    await page.getByRole('link', { name: 'Accounts' }).click();

    await expect(page.getByRole('heading', { name: 'Account management', level: 1 })).toBeVisible();

    const response = await accountsResponse;
    // The gateway let the read through only because a verified admin bearer was attached.
    expect(response.status()).toBe(200);
    expect(response.request().headers()['authorization']).toMatch(/^Bearer .+/);

    // The seeded accounts render as a table (at least a header + one data row).
    const table = page.getByRole('table', { name: 'accounts' });
    await expect(table).toBeVisible();
    const rows = table.getByRole('row');
    await expect(rows).not.toHaveCount(0);
  });

  test('renders the current-limits table from GET /balance/admin/limits', async ({ page }) => {
    await keycloakLogin(page, {
      entryPath: '/',
      username: requireUsername(),
      password: requirePassword(),
    });
    await expect(page.getByRole('heading', { name: 'Admin console', level: 1 })).toBeVisible();

    const limitsResponse = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return pathname.endsWith('/balance/admin/limits') && response.request().method() === 'GET';
    });

    await page.getByRole('link', { name: 'Limits' }).click();

    await expect(page.getByRole('heading', { name: 'Limits', level: 1 })).toBeVisible();

    const response = await limitsResponse;
    expect(response.status()).toBe(200);
    expect(response.request().headers()['authorization']).toMatch(/^Bearer .+/);

    // The global baseline (seeded) renders in the current-limits table.
    await expect(page.getByRole('table', { name: 'limits' })).toBeVisible();
  });
});
