import { type Page } from '@playwright/test';
import { APP_ORIGIN, OTP_ENTRY, requirePassword, requireUsername } from './env';

/**
 * Real OIDC Authorization-Code + PKCE login for the otp-app against Keycloak, driven through
 * the browser: navigate to the `/otp/` base -> redirected to the Keycloak realm login form ->
 * submit credentials -> land back on the app origin under `/otp`, where the SPA completes the
 * code exchange. This is the SEPARATE `otp-app` client login, a genuine second channel.
 *
 * Selectors target the stock Keycloak login theme (`#username` / `#password` / `#kc-login`);
 * adjust here if spec 08 ships a custom theme.
 */
export async function otpLogin(page: Page): Promise<void> {
  await page.goto(OTP_ENTRY);

  await page.waitForURL(/\/realms\/supercool\/protocol\/openid-connect\/auth/);
  await page.fill('#username', requireUsername());
  await page.fill('#password', requirePassword());
  await page.click('#kc-login');

  await page.waitForURL((url) => url.origin === APP_ORIGIN && !url.pathname.includes('/realms/'));
}
