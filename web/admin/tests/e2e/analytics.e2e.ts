import { expect, test } from '@playwright/test';
import { keycloakLogin } from './fixtures/auth';
import { requirePassword, requireUsername } from './fixtures/env';
import { e2eDescribe } from './fixtures/harness';

/**
 * Analytics dashboard (Step A5) end-to-end against the REAL stack. Unlike every other admin screen,
 * this one talks to the analytics server (spec 05) over a SECOND gateway namespace: browser ->
 * internal-nginx -> Kong (JWT verify, `admin` role enforced) -> analytics-server, where Kong strips
 * the `/analytics` prefix so the server still receives its own `/admin/reports/*` surface (ADR-17).
 * It rides the SAME OIDC bearer as `/balance/admin`, attached by a DISTINCT RTK Query slice
 * (`analyticsApi`). This proves that whole second path end-to-end: PKCE login -> navigate to
 * `/analytics` -> the two reporting reads traverse the internal gateway with an admin bearer and
 * return 200 -> the dashboard renders. None of this is covered by the MSW-stubbed component tests,
 * which mock the gateway away.
 *
 * Scope note: this is a REACHABILITY + RENDER smoke, NOT a data assertion. No transactions are
 * seeded, so the analytics read model is legitimately EMPTY and both reports return `200` with
 * empty arrays (`{ accountSummaries: [] }` / `{ dailyAggregates: [] }`). Asserting row counts or
 * specific rows here would be hollow (nothing to assert against) and flaky, so we assert only the
 * load-bearing facts a defect would break: each read returns 200 through the gateway carrying a
 * `Bearer` token, and the page renders its headings. Data-driven analytics assertions (and the
 * reversal / audit mutation flows) are separate later specs that need the seed expanded with real
 * transactions flowing producer -> consumer -> read model.
 *
 * PENDING until spec 08 (see tests/e2e/README.md): running docker-compose stack + a Keycloak login
 * user carrying the `admin` realm role. `describe.fixme` registers the spec so
 * `npx playwright test --list` enumerates it without a running stack or installed browsers.
 */
e2eDescribe('admin-app · analytics dashboard through the internal gateway', () => {
  test('renders the dashboard and both reports traverse /analytics/admin with an admin bearer', async ({
    page,
  }) => {
    // The app returns to `/` after PKCE (it does NOT restore a deep-linked route — redirect_uri is
    // the origin root), so log in at the root landing, then open the dashboard via the primary nav,
    // exactly as an admin would. The two report reads fire on that client-side navigation.
    await keycloakLogin(page, {
      entryPath: '/',
      username: requireUsername(),
      password: requirePassword(),
    });
    await expect(page.getByRole('heading', { name: 'Admin console', level: 1 })).toBeVisible();

    // Arm both response waits BEFORE the nav click that triggers them, so no report round-trip can
    // slip past us. Each matches on the request pathname + GET method — the exact
    // `/analytics/admin/reports/*` route the second gateway namespace must expose.
    const accountSummariesResponse = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        pathname.endsWith('/analytics/admin/reports/account-summaries') &&
        response.request().method() === 'GET'
      );
    });
    const dailyAggregatesResponse = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        pathname.endsWith('/analytics/admin/reports/daily-aggregates') &&
        response.request().method() === 'GET'
      );
    });

    await page.getByRole('link', { name: 'Analytics' }).click();

    // The dashboard renders: its page title plus the two report section headings.
    await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Daily aggregates', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Account summaries', level: 2 })).toBeVisible();

    // Both reads went through the SECOND gateway namespace and were admitted only because a verified
    // admin bearer was attached by the analytics slice. Empty read model is fine — 200 is the proof.
    const summaries = await accountSummariesResponse;
    expect(summaries.status()).toBe(200);
    expect(summaries.request().headers()['authorization']).toMatch(/^Bearer .+/);

    const aggregates = await dailyAggregatesResponse;
    expect(aggregates.status()).toBe(200);
    expect(aggregates.request().headers()['authorization']).toMatch(/^Bearer .+/);
  });
});
