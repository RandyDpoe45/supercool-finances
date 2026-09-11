import { expect, test } from '@playwright/test';
import { otpLogin } from './fixtures/auth';
import { e2eDescribe } from './fixtures/harness';

/**
 * otp-app DoD (spec 07 §The three apps): revealing calls `POST /balance/api/otp` and displays
 * the one-time code, and the SINGLETON is enforced — a second mint while a code is still
 * active returns `409 OTP_ALREADY_ACTIVE`. Run against the REAL stack.
 *
 * The displayed code is tied to the wire payload (DOM code == the `code` in the POST /otp
 * response). The singleton path is driven authentically: after a reveal the panel shows the
 * code (no button); a page reload resets only the client-side view, so clicking reveal again
 * hits the server while its minted code is still within ttl -> a real 409 -> the "already
 * active" message.
 *
 * PENDING until spec 08 (see tests/e2e/README.md): running stack + a Keycloak `otp-app` login
 * + a PENDING transfer for that user (seed one, or initiate it in the client-app first).
 */
e2eDescribe('otp-app · reveal one-time code and singleton enforcement', () => {
  test('reveal mints via POST /balance/api/otp and shows the returned code once', async ({
    page,
  }) => {
    await otpLogin(page);
    await expect(page.getByRole('region', { name: 'pending-authorization' })).toBeVisible();

    const mintResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/balance/api/otp') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /reveal/i }).click();
    const response = await mintResponse;
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { code: string; ttlSeconds: number };
    expect(body.code).toMatch(/^\d{6}$/);

    // The prominently displayed code must be exactly what the server returned.
    const shown = page.locator('[aria-label="one-time-code"]');
    await expect(shown).toBeVisible();
    await expect(shown).toHaveText(body.code);

    // The shown-once warning is the security contract: the code is never re-revealed.
    await expect(page.getByText(/Shown once/i)).toBeVisible();
  });

  test('a second mint while a code is still active is rejected 409 and surfaces the singleton message', async ({
    page,
  }) => {
    await otpLogin(page);
    await expect(page.getByRole('region', { name: 'pending-authorization' })).toBeVisible();

    // First mint succeeds and reveals a code.
    await page.getByRole('button', { name: /reveal/i }).click();
    await expect(page.locator('[aria-label="one-time-code"]')).toBeVisible();

    // Reload: the client-side reveal state resets (the button returns), but the server still
    // holds the active minted code — so a second reveal must collide with the singleton.
    await page.reload();
    await expect(page.getByRole('region', { name: 'pending-authorization' })).toBeVisible();
    const revealButton = page.getByRole('button', { name: /reveal/i });
    await expect(revealButton).toBeVisible();

    const secondMint = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/balance/api/otp') &&
        response.request().method() === 'POST',
    );
    await revealButton.click();
    const response = await secondMint;
    expect(response.status()).toBe(409);

    // The 409 is mapped to the user-facing singleton message (not a plaintext code).
    await expect(page.getByText(/A one-time code is already active/i)).toBeVisible();
    await expect(page.locator('[aria-label="one-time-code"]')).toHaveCount(0);
  });
});
