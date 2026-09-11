import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { keycloakLogin } from './fixtures/auth';
import {
  BASE_URL,
  requireCheckerPassword,
  requireCheckerUsername,
  requirePassword,
  requireUsername,
} from './fixtures/env';
import { e2eDescribe } from './fixtures/harness';

/**
 * DoD headline (spec 08): "an admin **maker-checker reversal** works from the admin app." This proves
 * the whole four-eyes reversal end-to-end against the REAL internal stack — browser ->
 * internal-nginx -> internal-Kong (JWT verify, `admin` role enforced, identity injected) ->
 * balance-service admin surface — NOT the MSW stub.
 *
 * It reverses the POSTED internal transfer the PUBLIC transfer-with-OTP chain created (accounts
 * `1000000001 -> 1000000002`), driving TWO distinct admins in TWO browser contexts so the four-eyes
 * rule is exercised for real, not mocked:
 *
 *  1. MAKER (`E2E_USERNAME` = demo-admin) logs in, finds the reversible transfer, and PROPOSES a
 *     reversal -> `POST /balance/admin/transfers/:id/reverse` returns 201 through the gateway and the
 *     proposal lands in the pending-approvals queue attributed to the maker.
 *  2. Four-eyes NEGATIVE: the maker tries to approve their OWN proposal -> the server 403s
 *     (`SELF_APPROVAL_FORBIDDEN`), the UI surfaces it, and nothing moves (approval stays PENDING, the
 *     target stays POSTED).
 *  3. CHECKER (`E2E_CHECKER_USERNAME` = demo-admin-2, a DIFFERENT identity) logs in in a SEPARATE
 *     context (its own fresh PKCE session — a shared context would carry the maker's SSO cookie and
 *     defeat the point), sees the maker's proposal, and APPROVES it ->
 *     `POST /balance/admin/approvals/:id/approve` returns 200 through the gateway, the approval leaves
 *     the pending queue, and the target transaction flips to REVERSED (the reversal EXECUTED).
 *  4. AUDIT TRAIL (same checker context): the executed reversal is audited — the Audit screen's
 *     `GET /balance/admin/audit` (PR #54) returns 200 through the gateway with a `Bearer` and the log
 *     contains a `reversal.executed` row. This audit-content proof lives HERE (not in `audit.e2e.ts`)
 *     because Playwright runs spec FILES alphabetically, so `audit.e2e.ts` (a < r) may run BEFORE any
 *     reversal exists and see an empty log; this spec CREATES the rows in-scope, so the assertion is
 *     order-proof.
 *
 * Load-bearing facts a real defect would break: the 201/200 through the gateway each carrying a
 * `Bearer`; the maker attribution on the proposal; the maker != checker identity separation; the
 * self-approval 403; the target flipping to REVERSED; and the reversal being audited. We assert NO
 * money amounts (nothing here seeded them) — the REVERSED flip is the money-safety proof.
 *
 * PENDING until spec 08 (see tests/e2e/README.md): running docker-compose stack + the seeded
 * reversible transfer (the public chain, sequenced first) + BOTH admin logins (demo-admin +
 * demo-admin-2, each carrying the `admin` realm role). `describe.fixme` registers the spec so
 * `npx playwright test --list` enumerates it without a running stack or installed browsers.
 */

/** Match the app's `GET /balance/admin/whoami` fetch on `page`, so a context's admin identity can be
 * tied back to the exact gateway-resolved payload (used to prove maker attribution + maker != checker). */
function whoamiResponse(page: Page) {
  return page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return pathname.endsWith('/balance/admin/whoami') && response.request().method() === 'GET';
  });
}

async function landOnAdminHome(page: Page, username: string, password: string): Promise<string> {
  // Capture whoami as the SPA fetches it post-PKCE, so we can read the gateway-resolved admin id.
  const whoami = whoamiResponse(page);
  await keycloakLogin(page, { entryPath: '/', username, password });
  await expect(page.getByRole('heading', { name: 'Admin console', level: 1 })).toBeVisible();

  const response = await whoami;
  expect(response.status()).toBe(200);
  expect(response.request().headers()['authorization']).toMatch(/^Bearer .+/);
  const identity = (await response.json()) as { userId: string; roles: string[] };
  // The admin plane is admin-only; a non-admin would have been rejected at the gateway.
  expect(identity.roles).toContain('admin');
  expect(identity.userId.length).toBeGreaterThan(0);
  return identity.userId;
}

e2eDescribe('admin-app · maker-checker reversal through the internal gateway', () => {
  test('maker proposes, a different checker approves, and the target transaction is REVERSED', async ({
    browser,
  }) => {
    // Each admin gets its OWN context (fresh Keycloak session) — a shared context would carry the
    // maker's SSO cookie and let the "checker" be the SAME user, defeating four-eyes. baseURL must be
    // passed explicitly: a manually created context does NOT inherit the config's `use.baseURL`.
    const makerContext = await browser.newContext({ baseURL: BASE_URL });
    let checkerContext: BrowserContext | undefined;
    try {
      // --- MAKER: propose the reversal -----------------------------------------------------------
      const makerPage = await makerContext.newPage();
      const makerId = await landOnAdminHome(makerPage, requireUsername(), requirePassword());

      await makerPage.getByRole('link', { name: 'Reversals' }).click();
      await expect(makerPage.getByRole('heading', { name: 'Reversals', level: 1 })).toBeVisible();

      // The reversible transfer is the row that OFFERS a Reverse button (POSTED internal / inbound);
      // non-reversible rows show an em-dash instead. Grab the first one and pin its id.
      const transactionsTable = makerPage.locator('table[aria-label="transactions"]');
      await expect(transactionsTable).toBeVisible();
      const reversibleRow = transactionsTable
        .locator('tbody tr')
        .filter({ has: makerPage.getByRole('button', { name: 'Reverse' }) })
        .first();
      await expect(reversibleRow).toBeVisible();
      const targetTxId = await reversibleRow.getAttribute('data-transaction-id');
      if (targetTxId === null) {
        throw new Error('reversible transaction row is missing its data-transaction-id');
      }
      // Pre-condition: the target starts POSTED (a reversible, un-reversed transaction).
      await expect(reversibleRow.locator('[data-status]')).toHaveAttribute('data-status', 'POSTED');

      // Reverse reveals the inline reason form (client-side); Confirm is what actually POSTs.
      await reversibleRow.getByRole('button', { name: 'Reverse' }).click();
      const reversalForm = makerPage.locator('form[aria-label="propose reversal"]');
      await expect(reversalForm).toBeVisible();
      await reversalForm.getByLabel('Reason (optional)').fill('e2e maker-checker reversal');

      // Arm the propose round-trip BEFORE Confirm so it cannot slip past; the id in the path proves
      // the exact target went to the exact gateway route.
      const proposeResponse = makerPage.waitForResponse((response) => {
        const pathname = new URL(response.url()).pathname;
        return (
          pathname.endsWith(`/balance/admin/transfers/${targetTxId}/reverse`) &&
          response.request().method() === 'POST'
        );
      });
      await reversalForm.getByRole('button', { name: 'Confirm reversal' }).click();
      const proposed = await proposeResponse;
      // 201 through the gateway, admitted only because a verified admin bearer was attached.
      expect(proposed.status()).toBe(201);
      expect(proposed.request().headers()['authorization']).toMatch(/^Bearer .+/);

      // The proposal now sits in the pending-approvals queue, targeting our tx and attributed to the
      // maker (four-eyes maker attribution resolved server-side from the caller identity == whoami).
      const approvalRow = makerPage
        .locator('table[aria-label="approvals"] tbody tr[data-approval-id]')
        .filter({ hasText: targetTxId })
        .first();
      await expect(approvalRow).toBeVisible();
      await expect(approvalRow.locator('td').nth(2)).toHaveText(targetTxId); // Target transaction
      await expect(approvalRow.locator('td').nth(3)).toHaveText(makerId); // Maker
      const approvalId = await approvalRow.getAttribute('data-approval-id');
      if (approvalId === null) {
        throw new Error('pending approval row is missing its data-approval-id');
      }

      // --- Four-eyes NEGATIVE: the maker cannot decide their own proposal ------------------------
      const selfApproveResponse = makerPage.waitForResponse((response) => {
        const pathname = new URL(response.url()).pathname;
        return (
          pathname.endsWith(`/balance/admin/approvals/${approvalId}/approve`) &&
          response.request().method() === 'POST'
        );
      });
      await approvalRow.getByRole('button', { name: 'Approve' }).click();
      const selfApprove = await selfApproveResponse;
      // The server enforces four-eyes: a maker approving their own proposal is 403 FORBIDDEN.
      expect(selfApprove.status()).toBe(403);
      expect(selfApprove.request().headers()['authorization']).toMatch(/^Bearer .+/);
      // The UI surfaces the rejection code, and NOTHING moved: the approval stays pending and the
      // target stays POSTED (the failed mutation triggers no cache invalidation → no state change).
      await expect(makerPage.getByRole('alert')).toContainText('SELF_APPROVAL_FORBIDDEN');
      await expect(approvalRow).toBeVisible();
      await expect(reversibleRow.locator('[data-status]')).toHaveAttribute('data-status', 'POSTED');

      // --- CHECKER: a DIFFERENT admin approves and the reversal executes -------------------------
      checkerContext = await browser.newContext({ baseURL: BASE_URL });
      const checkerPage = await checkerContext.newPage();
      const checkerId = await landOnAdminHome(
        checkerPage,
        requireCheckerUsername(),
        requireCheckerPassword(),
      );
      // Four-eyes at the identity level: the checker is genuinely a different admin than the maker.
      expect(checkerId).not.toBe(makerId);

      await checkerPage.getByRole('link', { name: 'Reversals' }).click();
      await expect(checkerPage.getByRole('heading', { name: 'Reversals', level: 1 })).toBeVisible();

      // The checker sees the maker's proposal (same approval id, made by the maker — not the checker).
      const checkerApprovalRow = checkerPage.locator(
        `table[aria-label="approvals"] tbody tr[data-approval-id="${approvalId}"]`,
      );
      await expect(checkerApprovalRow).toBeVisible();
      await expect(checkerApprovalRow.locator('td').nth(3)).toHaveText(makerId); // Maker != checker

      const approveResponse = checkerPage.waitForResponse((response) => {
        const pathname = new URL(response.url()).pathname;
        return (
          pathname.endsWith(`/balance/admin/approvals/${approvalId}/approve`) &&
          response.request().method() === 'POST'
        );
      });
      await checkerApprovalRow.getByRole('button', { name: 'Approve' }).click();
      const approved = await approveResponse;
      // 200 through the gateway with an admin bearer — the checker's approval executed the reversal.
      expect(approved.status()).toBe(200);
      expect(approved.request().headers()['authorization']).toMatch(/^Bearer .+/);

      // Executed: the approval leaves the PENDING queue...
      await expect(
        checkerPage.locator(
          `table[aria-label="approvals"] tbody tr[data-approval-id="${approvalId}"]`,
        ),
      ).toHaveCount(0);
      // ...and the target transaction is now REVERSED (the money-safety proof — the reversal moved
      // money exactly once, flipping the original's status).
      const checkerTargetRow = checkerPage.locator(
        `table[aria-label="transactions"] tbody tr[data-transaction-id="${targetTxId}"]`,
      );
      await expect(checkerTargetRow.locator('[data-status]')).toHaveAttribute(
        'data-status',
        'REVERSED',
      );

      // --- AUDIT TRAIL: the executed reversal is audited (order-proof — rows just created here) ---
      // Arm the audit read BEFORE the nav click that fires it.
      const auditRead = checkerPage.waitForResponse((response) => {
        const pathname = new URL(response.url()).pathname;
        return pathname.endsWith('/balance/admin/audit') && response.request().method() === 'GET';
      });
      await checkerPage.getByRole('link', { name: 'Audit' }).click();
      await expect(checkerPage.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();

      const audit = await auditRead;
      // The #54 audit read (`GET /balance/admin/audit`) traversed the gateway with an admin bearer.
      expect(audit.status()).toBe(200);
      expect(audit.request().headers()['authorization']).toMatch(/^Bearer .+/);

      // The log renders and contains a `reversal.executed` row — the just-executed reversal left an
      // audit trail. It is the newest admin action, so it is on the first (newest-first) page.
      const auditTable = checkerPage.locator('table[aria-label="audit log"]');
      await expect(auditTable).toBeVisible();
      await expect(
        auditTable.locator('code.audit-action', { hasText: 'reversal.executed' }).first(),
      ).toBeVisible();
    } finally {
      await checkerContext?.close();
      await makerContext.close();
    }
  });
});
