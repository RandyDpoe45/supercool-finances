import { expect, test } from '@playwright/test';
import { otpLogin } from './fixtures/auth';
import { e2eDescribe } from './fixtures/harness';

/**
 * DoD: "Each app completes PKCE login and calls its API through nginx/Kong." For the otp-app
 * this proves the SEPARATE `otp-app` login and the authenticated pending feed against the
 * REAL stack: PKCE round-trip -> bearer attached -> `GET /balance/api/pending-authorization`
 * traverses nginx + Kong -> the caller's real pending renders.
 *
 * The DOM is tied to the wire payload: the type label and currency shown in the feed must
 * match the `type`/`currency` of the authorization the API actually returned.
 *
 * PENDING until spec 08 (see tests/e2e/README.md): running stack + a Keycloak `otp-app` login
 * + a PENDING transfer for that user (seed one, or initiate it in the client-app first).
 */
e2eDescribe('otp-app · PKCE login and pending-authorization feed', () => {
  const TYPE_LABEL: Record<string, string> = {
    internal: 'Internal transfer',
    external_outbound: 'External transfer',
  };

  test('logs in via the otp-app client and renders the caller real pending authorization', async ({
    page,
  }) => {
    const pendingResponse = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        pathname.endsWith('/balance/api/pending-authorization') &&
        response.request().method() === 'GET'
      );
    });

    await otpLogin(page);

    const response = await pendingResponse;
    expect(response.status()).toBe(200);
    expect(response.request().headers()['authorization']).toMatch(/^Bearer .+/);

    const body = (await response.json()) as {
      authorization: { type: string; currency: string } | null;
    };
    // The DoD case needs a real pending to authorize; assert it exists (see prerequisites).
    expect(body.authorization).not.toBeNull();
    const authorization = body.authorization!;

    const feed = page.getByRole('region', { name: 'pending-authorization' });
    await expect(feed).toBeVisible();
    await expect(feed).toContainText(authorization.currency);
    await expect(feed).toContainText(TYPE_LABEL[authorization.type] ?? authorization.type);
  });
});
