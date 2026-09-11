import { expect, type Browser, type Page } from '@playwright/test';
import { APP_ORIGIN, requireOtpPassword, requireOtpUsername } from './env';

/**
 * Real OIDC Authorization-Code + PKCE login against Keycloak, driven through the browser
 * exactly as a user would: navigate to the SPA -> get redirected to the Keycloak realm login
 * form -> submit credentials -> land back on the app origin, where the SPA completes the code
 * exchange. This is a genuine round-trip through the identity provider, not a token stub.
 *
 * Selectors target the stock Keycloak login theme (`#username` / `#password` / `#kc-login`);
 * if spec 08 ships a custom theme these are the single place to adjust.
 */
export async function keycloakLogin(
  page: Page,
  options: { entryPath: string; username: string; password: string },
): Promise<void> {
  await page.goto(options.entryPath);

  // Redirected off-origin to the Keycloak authorization endpoint.
  await page.waitForURL(/\/realms\/supercool\/protocol\/openid-connect\/auth/);
  await page.fill('#username', options.username);
  await page.fill('#password', options.password);
  await page.click('#kc-login');

  // Back on the SPA origin (the code/state land here and are then stripped by the app).
  await page.waitForURL((url) => url.origin === APP_ORIGIN && !url.pathname.includes('/realms/'));
}

/** The whitelisted account shape the client renders (mirrors the app-local AccountDto). */
export interface E2EAccount {
  id: string;
  accountNumber: string | null;
  currency: string;
  kind: string;
  status: string;
  balance: string;
  held: string;
  available: string;
}

interface AccountsEnvelope {
  accounts: E2EAccount[];
}

/**
 * Reads the caller's accounts straight off the REAL `GET /balance/api/accounts` response the
 * app fetches when the overview mounts. Returning the wire values (canonical minor-unit
 * strings) lets the money-movement assertions compare with BigInt — never a float.
 */
export async function readAccounts(page: Page): Promise<E2EAccount[]> {
  const responsePromise = page.waitForResponse((response) => {
    const pathname = new URL(response.url()).pathname;
    return (
      pathname.endsWith('/balance/api/accounts') &&
      response.request().method() === 'GET' &&
      response.status() === 200
    );
  });
  await page.goto('/');
  const response = await responsePromise;
  const body = (await response.json()) as AccountsEnvelope;
  return body.accounts;
}

export function findAccount(accounts: E2EAccount[], id: string): E2EAccount {
  const account = accounts.find((candidate) => candidate.id === id);
  if (!account) {
    throw new Error(`account ${id} not present in the accounts response`);
  }
  return account;
}

/**
 * Solves the demo captcha that gates the sensitive forms. The challenge is a plain
 * "what is A + B?" prompt rendered in the field's label; parse the two operands and fill the
 * sum. (The operands are tiny UI integers, not money, so `Number` is fine here.)
 */
export async function solveCaptcha(page: Page): Promise<void> {
  const promptText = await page.getByText(/Confirm you are human/).innerText();
  const match = promptText.match(/what is (\d+) \+ (\d+)/i);
  if (!match) {
    throw new Error(`unexpected captcha prompt: ${promptText}`);
  }
  const sum = Number(match[1]) + Number(match[2]);
  await page.getByLabel(/Confirm you are human/).fill(String(sum));
}

/**
 * Drives the REAL otp-app in a SECOND Playwright browser context to obtain the one-time code
 * for the pending transfer the client-app just initiated — this is the cross-app,
 * out-of-band retrieval the DoD calls for ("code read from the otp-app"). A separate context
 * means separate cookies/session, so the otp-app performs its own PKCE login (the `otp-app`
 * client) as the same customer, its pending feed surfaces the live pending, and revealing
 * mints the code via `POST /balance/api/otp`. The caller must have initiated the transfer
 * first (a pending must exist) and must close the returned context.
 */
export async function revealOtpCodeFromOtpApp(
  browser: Browser,
): Promise<{ code: string; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await keycloakLogin(page, {
    entryPath: '/otp/',
    username: requireOtpUsername(),
    password: requireOtpPassword(),
  });

  // The pending the client just created must be visible to authorize.
  await expect(page.getByRole('region', { name: 'pending-authorization' })).toBeVisible();

  const otpMinted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/balance/api/otp') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /reveal/i }).click();
  const otpResponse = await otpMinted;
  expect(otpResponse.status()).toBe(200);

  const code = (await page.locator('[aria-label="one-time-code"]').innerText()).trim();
  // The real service mints a 6-digit CSPRNG code; assert the shape before returning it.
  expect(code).toMatch(/^\d{6}$/);

  return { code, close: () => context.close() };
}
