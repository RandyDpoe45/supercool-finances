import { expect, test } from '@playwright/test';
import {
  findAccount,
  keycloakLogin,
  readAccounts,
  revealOtpCodeFromOtpApp,
  solveCaptcha,
} from './fixtures/auth';
import { requirePassword, requireUsername, TRANSFER_MAJOR, TRANSFER_MINOR } from './fixtures/env';
import { e2eDescribe } from './fixtures/harness';

/**
 * The HEADLINE spec-07 DoD: "client-app completes an external transfer including the OTP step
 * (code read from the otp-app)." It runs against the REAL stack and proves the external
 * outbound rail end-to-end: pick a usable payee -> initiate (PENDING + HOLD) -> obtain the
 * one-time code from the REAL otp-app in a SECOND browser context -> confirm -> settle.
 *
 * The money-safety assertions distinguish the external rail from the internal one via the
 * HOLD, compared as BigInt over the canonical minor-unit wire strings:
 *   - at initiate a hold is placed: `available` drops by the amount while `balance` is
 *     unchanged and `held` rises by the amount (money reserved, not yet moved);
 *   - at OTP confirm the hold settles: `balance` drops by the amount, `held` returns to its
 *     baseline, `available` stays reduced — money moves exactly once, none created or lost.
 * The mid-flow balance read also exercises the documented resume-on-mount (the pending is
 * restored to the confirm step after navigating away and back).
 *
 * PENDING until spec 08 (see tests/e2e/README.md): stack + a USABLE seeded payee (past its
 * cooling-off) + a funded source account + Keycloak logins for the customer AND the otp-app.
 */
e2eDescribe('client-app · external transfer with hold and out-of-band OTP', () => {
  test('places a hold at initiate and settles it on OTP confirm — exact hold then settle', async ({
    page,
    browser,
  }) => {
    await keycloakLogin(page, {
      entryPath: '/',
      username: requireUsername(),
      password: requirePassword(),
    });

    const before = await readAccounts(page);

    // Select a usable enrolled payee from the payees list (the "Send money" deep-link only
    // appears for payees past their cooling-off), landing on the external-transfer flow.
    await page.goto('/payees');
    const payeeList = page.getByRole('list', { name: 'payees' });
    await payeeList.getByRole('link', { name: 'Send money' }).first().click();
    await expect(
      page.getByRole('heading', { name: 'Pay an external payee', level: 1 }),
    ).toBeVisible();

    // Compose: capture the source account id (the select value) for the balance assertions.
    const sourceId = await page.getByLabel('From account').inputValue();
    expect(sourceId).not.toBe('');
    await page.getByLabel(/^Amount/).fill(TRANSFER_MAJOR);
    await solveCaptcha(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // Initiate created a PENDING transfer AND placed a hold; the confirm step now awaits OTP.
    await expect(page.getByLabel('One-time code')).toBeVisible();

    // Hold invariant: available reserved, balance untouched, held raised — before any settle.
    const afterInit = await readAccounts(page);
    const src0 = findAccount(before, sourceId);
    const srcHeld = findAccount(afterInit, sourceId);
    const amount = BigInt(TRANSFER_MINOR);

    expect(BigInt(srcHeld.balance)).toBe(BigInt(src0.balance));
    expect(BigInt(srcHeld.held) - BigInt(src0.held)).toBe(amount);
    expect(BigInt(src0.available) - BigInt(srcHeld.available)).toBe(amount);

    // Resume the pending (documented resume-on-mount) after navigating away to read balances.
    await page.goto('/transfers/external');
    await expect(page.getByLabel('One-time code')).toBeVisible();

    // Out-of-band code from the REAL otp-app (second context), then confirm -> settle.
    const otp = await revealOtpCodeFromOtpApp(browser);
    try {
      await page.getByLabel('One-time code').fill(otp.code);
      await page.getByRole('button', { name: 'Confirm transfer' }).click();
      await expect(page.getByText('Transfer sent.')).toBeVisible();
    } finally {
      await otp.close();
    }

    // Settle invariant: hold becomes a posted debit — balance down by the amount, held back to
    // baseline, available still reduced (money moved exactly once).
    const afterConfirm = await readAccounts(page);
    const src1 = findAccount(afterConfirm, sourceId);

    expect(BigInt(src0.balance) - BigInt(src1.balance)).toBe(amount);
    expect(BigInt(src1.held)).toBe(BigInt(src0.held));
    expect(BigInt(src0.available) - BigInt(src1.available)).toBe(amount);
  });

  test('a freshly enrolled payee is shown in cooling-off and cannot yet be paid', async ({
    page,
  }) => {
    await keycloakLogin(page, {
      entryPath: '/',
      username: requireUsername(),
      password: requirePassword(),
    });

    await page.goto('/payees');
    await expect(page.getByRole('heading', { name: 'Payees', level: 1 })).toBeVisible();

    // A unique name/ref per run so re-runs don't collide with the uq_payee constraint.
    const suffix = String(Date.now()).slice(-12);
    const displayName = `E2E Payee ${suffix}`;

    await page.getByLabel('Payee name').fill(displayName);
    await page.getByLabel('External account number').fill(suffix);
    await solveCaptcha(page);
    await page.getByRole('button', { name: 'Enroll payee' }).click();

    // The anti-fraud control is surfaced: enrollment does NOT make the payee immediately usable.
    const enrolled = page.getByRole('status').filter({ hasText: displayName });
    await expect(enrolled).toBeVisible();
    await expect(enrolled).toContainText('cooling-off period');

    // In the list the new payee shows a "usable from" state and offers NO send action yet.
    const row = page
      .getByRole('list', { name: 'payees' })
      .getByRole('listitem')
      .filter({ hasText: displayName });
    await expect(row).toContainText('Usable from');
    await expect(row.getByRole('link', { name: 'Send money' })).toHaveCount(0);
  });
});
