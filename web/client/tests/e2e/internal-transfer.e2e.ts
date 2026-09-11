import { expect, test } from '@playwright/test';
import {
  findAccount,
  keycloakLogin,
  readAccounts,
  revealOtpCodeFromOtpApp,
  solveCaptcha,
} from './fixtures/auth';
import {
  DEST_ACCOUNT,
  requirePassword,
  requireUsername,
  TRANSFER_MAJOR,
  TRANSFER_MINOR,
} from './fixtures/env';
import { e2eDescribe } from './fixtures/harness';

/**
 * Internal transfer end-to-end against the REAL stack, including the out-of-band OTP step.
 * This mirrors the external headline flow (spec 07 DoD) for the internal rail: confirmation
 * of payee -> amount + captcha -> initiate (PENDING, no money moves yet) -> OTP code obtained
 * from the REAL otp-app in a second browser context -> confirm -> settle.
 *
 * The money-safety assertion is exact: an internal settle debits the source `balance` by the
 * transfer amount, leaves `held` untouched (no hold on the internal rail), and drops
 * `available` by the same amount. Values are compared as BigInt over the canonical minor-unit
 * wire strings, so the test would catch a wrong amount, a double debit, or money conjured.
 *
 * PENDING until spec 08 (see tests/e2e/README.md): stack + seeded source/destination accounts
 * (destination = E2E_DEST_ACCOUNT, same currency as a source, funded for E2E_TRANSFER_MAJOR)
 * + Keycloak logins for the customer AND the otp-app.
 */
e2eDescribe('client-app · internal transfer with out-of-band OTP', () => {
  test('confirmation-of-payee -> initiate -> OTP confirm settles and debits the source exactly once', async ({
    page,
    browser,
  }) => {
    await keycloakLogin(page, {
      entryPath: '/',
      username: requireUsername(),
      password: requirePassword(),
    });

    const before = await readAccounts(page);

    // Step 1 — confirmation of payee.
    await page.getByRole('link', { name: 'Send money' }).click();
    await expect(page.getByRole('heading', { name: 'Send money', level: 1 })).toBeVisible();
    await page.getByLabel('Destination account number').fill(DEST_ACCOUNT);
    await page.getByRole('button', { name: 'Look up account' }).click();

    // The service discloses only a MASKED holder name; the payer confirms the destination.
    await expect(page.getByText('Please confirm you are paying:')).toBeVisible();
    await expect(page.getByText(DEST_ACCOUNT, { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Yes, this is correct' }).click();

    // Step 2 — amount + source + captcha. Record which of the caller's accounts is the source
    // (the select's value is the account id) so we can assert the movement on that account.
    const sourceId = await page.getByLabel('From account').inputValue();
    expect(sourceId).not.toBe('');
    await page.getByLabel(/^Amount/).fill(TRANSFER_MAJOR);
    await solveCaptcha(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // Step 3 — the transfer is PENDING and awaits the out-of-band code.
    await expect(page.getByLabel('One-time code')).toBeVisible();

    // Cross-app, out-of-band retrieval: the code comes from the REAL otp-app (second context).
    const otp = await revealOtpCodeFromOtpApp(browser);
    try {
      await page.getByLabel('One-time code').fill(otp.code);
      await page.getByRole('button', { name: 'Confirm transfer' }).click();
      await expect(page.getByText('Transfer sent.')).toBeVisible();
    } finally {
      await otp.close();
    }

    // Money-safety: exact settle on the source, no hold, nothing created or lost.
    const after = await readAccounts(page);
    const src0 = findAccount(before, sourceId);
    const src1 = findAccount(after, sourceId);
    const amount = BigInt(TRANSFER_MINOR);

    expect(BigInt(src0.balance) - BigInt(src1.balance)).toBe(amount);
    expect(BigInt(src1.held)).toBe(BigInt(src0.held));
    expect(BigInt(src0.available) - BigInt(src1.available)).toBe(amount);
  });
});
