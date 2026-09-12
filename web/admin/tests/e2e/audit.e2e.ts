import { expect, test } from '@playwright/test';
import { keycloakLogin } from './fixtures/auth';
import { requirePassword, requireUsername } from './fixtures/env';
import { e2eDescribe } from './fixtures/harness';

/**
 * Standalone reachability smoke for the `/audit` route + the admin audit read
 * (`GET /balance/admin/audit`, PR #54): it proves the screen loads and the read traverses the REAL
 * internal stack — browser -> internal-nginx -> internal-Kong (JWT verify, `admin` role enforced) ->
 * balance-service admin surface — returning 200 with an admin `Bearer`, and that the `/audit` screen
 * renders.
 *
 * DELIBERATELY order-INDEPENDENT. Playwright runs spec FILES alphabetically, so this file (a < r)
 * may run BEFORE `reversals.e2e.ts`, when the audit log is legitimately EMPTY — so it accepts EITHER
 * the populated table OR the "No audit entries." empty state (mirroring the analytics smoke's
 * tolerance). The audit CONTENT/trail — that an executed reversal produces a `reversal.executed` row —
 * is proven in `reversals.e2e.ts`, which CREATES the rows in-scope and asserts them there (order-proof).
 * Asserting a specific reversal row HERE would be a hidden cross-spec dependency that fails on
 * alphabetical ordering, so it is intentionally not attempted.
 *
 * PENDING until spec 08 (see tests/e2e/README.md): running docker-compose stack + a Keycloak admin
 * login (`admin` realm role). `describe.fixme` registers the spec so `npx playwright test --list`
 * enumerates it without a running stack or installed browsers.
 */
e2eDescribe('admin-app · audit read + /audit screen reachable through the gateway', () => {
  test('renders the /audit screen and the audit read returns 200 with an admin bearer', async ({
    page,
  }) => {
    // The app returns to `/` after PKCE (no deep-link restoration), so log in at the root landing and
    // open the audit screen via the primary nav — the audit read fires on that client-side navigation.
    await keycloakLogin(page, {
      entryPath: '/',
      username: requireUsername(),
      password: requirePassword(),
    });
    await expect(page.getByRole('heading', { name: 'Admin console', level: 1 })).toBeVisible();

    // Arm the audit read BEFORE the nav click that triggers it, so it cannot slip past us.
    const auditResponse = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return pathname.endsWith('/balance/admin/audit') && response.request().method() === 'GET';
    });

    await page.getByRole('link', { name: 'Audit' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();

    const response = await auditResponse;
    // The gateway admitted the read only because a verified admin bearer was attached.
    expect(response.status()).toBe(200);
    expect(response.request().headers()['authorization']).toMatch(/^Bearer .+/);

    // The `/audit` screen rendered its read result: EITHER a populated log table OR the empty state.
    // Which one depends on whether a reversal has run yet (alphabetical spec order), so accept either —
    // the content/trail assertion lives in reversals.e2e.ts where the rows are guaranteed to exist.
    const table = page.locator('table[aria-label="audit log"]');
    const emptyState = page.getByText('No audit entries.');
    await expect(table.or(emptyState)).toBeVisible();
  });
});
