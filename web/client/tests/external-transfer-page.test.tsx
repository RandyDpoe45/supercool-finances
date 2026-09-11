import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Make the same-origin `/balance/api` base absolute before baseApi captures the env (identical to the other
// page tests); MSW still matches its relative handlers against the same origin.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/api`);
});

import { PayeesPage } from '../src/components/pages/PayeesPage';
import { ExternalTransferPage } from '../src/components/pages/ExternalTransferPage';
import { baseApi } from '../src/services/api/baseApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import { resetTransferStore } from '../src/mocks/state/transferStore';
import { resetPayeeStore } from '../src/mocks/state/payeeStore';
import { fixturePayees } from '../src/mocks/fixtures/payees';
import { fixtureAccounts } from '../src/mocks/fixtures/accounts';
import type { AccountsResponse, AccountDto } from '../src/services/api/contracts/accounts';

/**
 * The external-transfer journey end to end over a fresh store + live MSW + a REAL signed-in session
 * (so the RTK Query bearer is attached exactly as in production). Nothing mocks the flow reducer, the
 * money helpers, or the mutations. These prove the SPEC's external-outbound behaviors as the user
 * experiences them (spec 07 client-app + spec 04 external outbound):
 *
 *  - a cooling-off payee is NOT selectable (hint), while a usable one exposes a "Send money" link;
 *  - enrollment is captcha-gated, sends ONLY the two whitelisted fields, and surfaces the cooling-off
 *    window (a freshly enrolled payee cannot receive money yet — the anti-fraud gate);
 *  - the external send is captcha-gated and places a HOLD (source `available` drops at initiate),
 *    then the OTP settles it (balance decremented) — amounts always FORMATTED, no raw minor units;
 *  - a stale-usable hint does NOT override the server: a `PAYEE_IN_COOLING_OFF` is surfaced and the
 *    flow does NOT proceed (no hold placed).
 */

const SOURCE_ID = fixtureAccounts[0].id; // available 1500000
const USABLE_PAYEE = fixturePayees[0]; // Landlord — usable
const COOLING_PAYEE = fixturePayees[1]; // New Supplier — cooling off
const DEV_OTP_CODE = '123456';
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);
const AUTH = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
const url = (path: string) => new URL(path, window.location.origin).toString();

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function renderPayeesPage() {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={['/payees']}>
        <PayeesPage />
      </MemoryRouter>
    </Provider>,
  );
}

function renderExternalPage(entry = '/transfers/external') {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[entry]}>
        <ExternalTransferPage />
      </MemoryRouter>
    </Provider>,
  );
}

/** Read the single demo captcha's arithmetic challenge and enter the correct answer. */
function solveCaptcha() {
  const label = screen.getByText(/what is \d+ \+ \d+/i);
  const match = label.textContent?.match(/what is (\d+) \+ (\d+)/i);
  if (!match) {
    throw new Error(`captcha challenge not found in: ${label.textContent}`);
  }
  const sum = Number(match[1]) + Number(match[2]);
  fireEvent.change(screen.getByLabelText(/confirm you are human/i), {
    target: { value: String(sum) },
  });
}

async function readSource(): Promise<AccountDto> {
  const res = await fetch(url('/balance/api/accounts'), { headers: AUTH });
  const { accounts } = (await res.json()) as AccountsResponse;
  const source = accounts.find((a) => a.id === SOURCE_ID);
  if (!source) {
    throw new Error('source account missing');
  }
  return source;
}

beforeEach(async () => {
  resetTransferStore();
  resetPayeeStore();
  await userManager.storeUser(
    new User({
      access_token: 'external-page-token',
      token_type: 'Bearer',
      session_state: null,
      scope: 'openid profile',
      expires_at: NOW_SECONDS() + 3600,
      profile: {
        sub: 'user-abc',
        iss: 'http://keycloak.localtest.me:8082/realms/supercool',
        aud: 'supercool-api',
        exp: NOW_SECONDS() + 3600,
        iat: NOW_SECONDS(),
      },
    }),
  );
});

afterEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
  resetTransferStore();
  resetPayeeStore();
});

describe('PayeesPage — cooling-off gating (hint) + enrollment', () => {
  it('offers "Send money" only for a usable payee; a cooling-off payee shows when it becomes usable', async () => {
    renderPayeesPage();
    const list = await screen.findByRole('list', { name: 'payees' });
    const items = within(list).getAllByRole('listitem');

    const usableCard = items.find((li) => li.textContent?.includes(USABLE_PAYEE.displayName));
    const coolingCard = items.find((li) => li.textContent?.includes(COOLING_PAYEE.displayName));
    expect(usableCard).toBeDefined();
    expect(coolingCard).toBeDefined();

    // Usable payee: a Send-money link into the external flow, pre-selecting this payee.
    const sendLink = within(usableCard!).getByRole('link', { name: /send money/i });
    expect(sendLink).toHaveAttribute('href', `/transfers/external?payeeId=${USABLE_PAYEE.id}`);

    // Cooling-off payee: NO send action, and it tells the user when it becomes usable (the gate).
    expect(within(coolingCard!).queryByRole('link', { name: /send money/i })).toBeNull();
    expect(coolingCard!.textContent).toMatch(/usable from/i);
  });

  it('captcha-gates enrollment, sends ONLY {displayName, destinationRef}, and shows the cooling-off window', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post('/balance/api/payees', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: 'enrolled-1111-0000-4000-8000-000000000001',
            displayName: captured.displayName,
            destinationRef: captured.destinationRef,
            coolingOffUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            usable: false,
            createdAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    renderPayeesPage();
    await screen.findByLabelText(/payee name/i);

    fireEvent.change(screen.getByLabelText(/payee name/i), { target: { value: 'Butcher' } });
    fireEvent.change(screen.getByLabelText(/external account number/i), {
      target: { value: '9000000123' },
    });

    // Captcha gates enroll: disabled, and a disabled click sends nothing.
    const enroll = screen.getByRole('button', { name: /enroll payee/i });
    expect(enroll).toBeDisabled();
    fireEvent.click(enroll);
    expect(captured).toBeUndefined();

    solveCaptcha();
    await waitFor(() => expect(enroll).toBeEnabled());
    fireEvent.click(enroll);

    // The wire body carries EXACTLY the two whitelisted fields — never rail/status/coolingOffUntil.
    await waitFor(() => expect(captured).toBeDefined());
    expect(Object.keys(captured!).sort()).toEqual(['destinationRef', 'displayName']);
    expect(captured).toEqual({ displayName: 'Butcher', destinationRef: '9000000123' });

    // A freshly enrolled payee is NOT usable — the page surfaces the cooling-off window, not a
    // "ready now" message.
    expect(await screen.findByText(/cooling-off period/i)).toBeInTheDocument();
    expect(screen.queryByText(/ready to receive money now/i)).not.toBeInTheDocument();
  });
});

describe('ExternalTransferForm — only usable payees are selectable', () => {
  it('offers the usable payee and never the cooling-off one', async () => {
    renderExternalPage();
    const paySelect = await screen.findByLabelText('Pay');
    expect(within(paySelect).getByRole('option', { name: /Landlord/ })).toBeInTheDocument();
    expect(within(paySelect).queryByRole('option', { name: /New Supplier/ })).toBeNull();
  });
});

describe('ExternalTransferPage — captcha gates the send (a disabled click places no hold)', () => {
  it('keeps Send disabled until amount valid AND captcha solved; no initiate while disabled', async () => {
    renderExternalPage(`/transfers/external?payeeId=${USABLE_PAYEE.id}`);
    await screen.findByLabelText('Pay');

    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '500.00' } });
    expect(send).toBeDisabled(); // captcha still gates it
    fireEvent.click(send); // disabled click must do nothing

    // No confirm step, and — critically — NO hold was placed (available untouched).
    expect(screen.queryByLabelText(/one-time code/i)).not.toBeInTheDocument();
    const source = await readSource();
    expect(source.available).toBe('1500000');
    expect(source.held).toBe('0');

    solveCaptcha();
    await waitFor(() => expect(send).toBeEnabled());
  });
});

describe('ExternalTransferPage — the money-moving journey (hold → settle)', () => {
  it('sends (available drops), then OTP-confirms (balance decremented); amounts formatted, no raw units', async () => {
    renderExternalPage(`/transfers/external?payeeId=${USABLE_PAYEE.id}`);
    await screen.findByLabelText('Pay');

    // Source options show FORMATTED available balances, never raw minor units.
    const fromSelect = screen.getByLabelText(/from account/i);
    expect(within(fromSelect).getByText(/15,000\.00 MXN available/)).toBeInTheDocument();
    expect(fromSelect.textContent).not.toContain('1500000');

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '500.00' } });
    solveCaptcha();
    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    // Confirm step: the amount is FORMATTED (500.00 MXN), the raw minor units never render.
    await screen.findByLabelText(/one-time code/i);
    expect(screen.getByText(/500\.00 MXN/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('50000');

    // The HOLD was placed at initiate — the source's available dropped by the amount NOW.
    const held = await readSource();
    expect(held.available).toBe('1450000');
    expect(held.held).toBe('50000');
    expect(held.balance).toBe('1500000'); // money not yet moved

    // OTP settle → POSTED (money moves).
    fireEvent.change(screen.getByLabelText(/one-time code/i), { target: { value: DEV_OTP_CODE } });
    fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));
    expect(await screen.findByText(/transfer sent/i)).toBeInTheDocument();
    expect(screen.getByText(/500\.00 MXN/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('50000');

    // Settled: balance decremented by the amount, the hold released.
    await waitFor(async () => {
      const settled = await readSource();
      expect(settled.balance).toBe('1450000');
      expect(settled.held).toBe('0');
      expect(settled.available).toBe('1450000');
    });
  });

  it('cancel releases the hold — the source available is restored', async () => {
    renderExternalPage(`/transfers/external?payeeId=${USABLE_PAYEE.id}`);
    await screen.findByLabelText('Pay');

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '500.00' } });
    solveCaptcha();
    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    await screen.findByLabelText(/one-time code/i);
    expect((await readSource()).available).toBe('1450000'); // hold placed

    fireEvent.click(screen.getByRole('button', { name: /cancel transfer/i }));
    expect(await screen.findByText(/transfer cancelled/i)).toBeInTheDocument();

    await waitFor(async () => {
      const released = await readSource();
      expect(released.available).toBe('1500000');
      expect(released.held).toBe('0');
    });
  });
});

describe('ExternalTransferPage — the server, not the hint, is authoritative on cooling-off', () => {
  it('a stale-usable payee is rejected PAYEE_IN_COOLING_OFF; the flow does not proceed and places no hold', async () => {
    // The list falsely hints the still-cooling payee is usable (a stale `usable: true`), so the form
    // offers it — but the server re-checks the gate on the real clock and rejects it.
    server.use(
      http.get('/balance/api/payees', () =>
        HttpResponse.json({
          payees: [
            {
              id: COOLING_PAYEE.id,
              displayName: COOLING_PAYEE.displayName,
              destinationRef: COOLING_PAYEE.destinationRef,
              coolingOffUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
              usable: true, // STALE hint
              createdAt: new Date(Date.now() - 60_000).toISOString(),
            },
          ],
        }),
      ),
    );

    renderExternalPage(`/transfers/external?payeeId=${COOLING_PAYEE.id}`);
    await screen.findByLabelText('Pay');

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '500.00' } });
    solveCaptcha();
    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    // The server's authoritative gate is surfaced, and the flow stays on compose (no confirm step).
    expect(await screen.findByText(/still in its cooling-off period/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/one-time code/i)).not.toBeInTheDocument();

    // No hold was placed — the money boundary is untouched.
    const source = await readSource();
    expect(source.available).toBe('1500000');
    expect(source.held).toBe('0');
  });
});
