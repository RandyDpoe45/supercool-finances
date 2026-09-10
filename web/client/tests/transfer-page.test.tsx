import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's node fetch cannot resolve the app's relative `/api` base; make the SAME same-origin base
// absolute against the test origin before baseApi captures the env at import (identical to the
// bearer/statement tests). MSW resolves its relative handlers against the same origin, so the
// requests still match.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/api`);
});

// Importing the page registers accountsApi + transfersApi endpoints on baseApi.
import { TransferPage } from '../src/components/pages/TransferPage';
import { TransferAmountForm } from '../src/components/organisms/TransferAmountForm';
import { baseApi } from '../src/services/api/baseApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import { fixtureAccounts } from '../src/mocks/fixtures/accounts';
import { resetTransferStore } from '../src/mocks/state/transferStore';
import type { AccountDto } from '../src/services/api/contracts/accounts';
import type { ResolvedPayee } from '../src/lib/transferFlow';

/**
 * The internal-transfer journey end to end over a fresh store + live MSW + a REAL signed-in session
 * (so the RTK Query bearer is attached exactly as in production). Nothing mocks the flow reducer, the
 * money helpers, or the mutations. These prove the money-moving behaviors of spec 04 Transfers as the
 * user experiences them:
 *
 *  - the full journey: resolve destination → confirm masked payee → source + amount → captcha →
 *    Send (initiate PENDING) → OTP code → POSTED, with the accounts cache INVALIDATED afterwards
 *    (balances refetched — the load-bearing money-safety proof, since a POSTED confirm moved money);
 *  - a wrong OTP surfaces an error and leaves the transfer PENDING (retryable);
 *  - the suspected-duplicate "Send anyway" path re-submits;
 *  - cancel takes a pending transfer to CANCELLED;
 *  - every amount is rendered FORMATTED — a raw minor-unit string must never reach the DOM.
 */

const SEEDED_DESTINATION = '2000000001';
const MASKED_NAME = 'Mar** Góm**';
const DEV_OTP_CODE = '123456';
const SOURCE_ACCOUNT_ID = fixtureAccounts[0].id;
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);
const AUTH = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
const url = (path: string) => new URL(path, window.location.origin).toString();

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function renderTransferPage() {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={['/transfers/new']}>
        <TransferPage />
      </MemoryRouter>
    </Provider>,
  );
}

/** Install a counting GET /api/accounts handler so a post-confirm refetch (cache invalidation) is
 * observable. Returns a getter for the number of times it was hit. */
function countAccountsFetches(): () => number {
  let count = 0;
  server.use(
    http.get('/api/accounts', () => {
      count += 1;
      return HttpResponse.json({ accounts: fixtureAccounts });
    }),
  );
  return () => count;
}

/** Read the demo captcha's arithmetic challenge from its label and enter the correct answer. */
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

/** Drive resolve → confirm payee → amount + captcha → Send, and wait for the OTP confirm panel. */
async function driveToConfirmPanel(amount = '100.50') {
  fireEvent.change(await screen.findByLabelText(/destination account number/i), {
    target: { value: SEEDED_DESTINATION },
  });
  fireEvent.click(screen.getByRole('button', { name: /look up account/i }));

  fireEvent.click(await screen.findByRole('button', { name: /yes, this is correct/i }));

  fireEvent.change(await screen.findByLabelText(/amount/i), { target: { value: amount } });
  solveCaptcha();

  const send = screen.getByRole('button', { name: 'Send' });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);

  await screen.findByLabelText(/one-time code/i);
}

beforeEach(async () => {
  resetTransferStore();
  await userManager.storeUser(
    new User({
      access_token: 'transfer-access-token',
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
});

describe('TransferPage — happy journey (money moves, balances refetch)', () => {
  it('resolves → confirms payee → sends → OTP-confirms → POSTED, then invalidates the accounts cache', async () => {
    const accountsFetches = countAccountsFetches();
    renderTransferPage();

    // Step 1: confirmation of payee — the masked name is shown (raw PII never reaches the client).
    fireEvent.change(await screen.findByLabelText(/destination account number/i), {
      target: { value: SEEDED_DESTINATION },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up account/i }));
    expect(await screen.findByText(MASKED_NAME)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /yes, this is correct/i }));

    // Step 2: amount + source. The source options show FORMATTED available balances, never raw units.
    await screen.findByLabelText(/amount/i);
    expect(screen.getByText(/15,000\.00 MXN available/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('1500000');

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '100.50' } });

    // Step 3: captcha gates initiate — Send is disabled until it is solved.
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    solveCaptcha();
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    // Step 4: OTP confirm. The pending summary shows the FORMATTED amount and masked destination.
    await screen.findByLabelText(/one-time code/i);
    expect(screen.getByText(/100\.50 MXN/)).toBeInTheDocument();
    expect(document.body.textContent).toContain(MASKED_NAME); // masked destination shown
    expect(document.body.textContent).not.toContain('10050'); // raw minor units never rendered

    const beforeConfirm = accountsFetches();
    fireEvent.change(screen.getByLabelText(/one-time code/i), { target: { value: DEV_OTP_CODE } });
    fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));

    // POSTED — and money moved, so the accounts list must refetch (cache invalidation).
    expect(await screen.findByText(/transfer sent/i)).toBeInTheDocument();
    await waitFor(() => expect(accountsFetches()).toBeGreaterThan(beforeConfirm));
    // The receipt still renders the amount formatted, never raw.
    expect(screen.getByText(/100\.50 MXN/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('10050');
  });
});

describe('TransferPage — wrong OTP stays pending and is retryable', () => {
  it('surfaces an INVALID_OTP message, keeps the confirm step, then posts on the correct code', async () => {
    renderTransferPage();
    await driveToConfirmPanel();

    fireEvent.change(screen.getByLabelText(/one-time code/i), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));

    // Wrong code → clear message, still on the confirm step (not posted, not cancelled).
    expect(await screen.findByText(/one-time code is invalid/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/one-time code/i)).toBeInTheDocument();
    expect(screen.queryByText(/transfer sent/i)).not.toBeInTheDocument();

    // Retrying with the correct code posts it.
    fireEvent.change(screen.getByLabelText(/one-time code/i), { target: { value: DEV_OTP_CODE } });
    fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));
    expect(await screen.findByText(/transfer sent/i)).toBeInTheDocument();
  });
});

describe('TransferPage — suspected duplicate offers "Send anyway"', () => {
  it('soft-blocks an identical recent payment, then proceeds via confirmDuplicate', async () => {
    // Pre-seed the soft-duplicate window: an identical payment already went through and was
    // cancelled, so the fingerprint is "recent" but there is no active pending to auto-resume.
    const resolveRes = await fetch(url('/api/transfers/resolve-destination'), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ accountNumber: SEEDED_DESTINATION }),
    });
    const { confirmationToken } = (await resolveRes.json()) as { confirmationToken: string };
    const priorRes = await fetch(url('/api/transfers'), {
      method: 'POST',
      headers: { ...AUTH, 'Idempotency-Key': 'prior-key' },
      body: JSON.stringify({
        sourceAccountId: SOURCE_ACCOUNT_ID,
        destinationAccountNumber: SEEDED_DESTINATION,
        amount: '10050',
        currency: 'MXN',
        confirmationToken,
      }),
    });
    const prior = (await priorRes.json()) as { id: string };
    await fetch(url(`/api/transfers/${prior.id}/cancel`), { method: 'POST', headers: AUTH });

    renderTransferPage();

    fireEvent.change(await screen.findByLabelText(/destination account number/i), {
      target: { value: SEEDED_DESTINATION },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up account/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, this is correct/i }));

    fireEvent.change(await screen.findByLabelText(/amount/i), { target: { value: '100.50' } });
    solveCaptcha();
    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    // Soft-blocked: a duplicate warning + the submit becomes "Send anyway".
    expect(await screen.findByText(/looks like a duplicate/i)).toBeInTheDocument();
    const sendAnyway = await screen.findByRole('button', { name: /send anyway/i });

    fireEvent.click(sendAnyway);
    // Proceeds to the OTP confirm step.
    expect(await screen.findByLabelText(/one-time code/i)).toBeInTheDocument();
  });
});

describe('TransferPage — cancel a pending transfer', () => {
  it('takes a pending transfer to CANCELLED and does NOT refetch accounts (no money moved)', async () => {
    // Symmetric to the happy-path confirm test's cache-invalidation proof — but the OPPOSITE
    // assertion. `useGetAccountsQuery` stays subscribed for the whole page lifetime (top-level in
    // TransferPage), so a mistaken `Account` invalidation on cancelTransfer WOULD refetch the list
    // and bump this counter. A cancel moves no money, so the balances must NOT be re-read.
    const accountsFetches = countAccountsFetches();
    renderTransferPage();
    await driveToConfirmPanel();

    const beforeCancel = accountsFetches();
    fireEvent.click(screen.getByRole('button', { name: /cancel transfer/i }));
    expect(await screen.findByText(/transfer cancelled/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/one-time code/i)).not.toBeInTheDocument();

    // Give any (mistaken) Account invalidation the same window the confirm test observes a real
    // refetch within, then assert the count never moved — cancel must not invalidate the cache.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(accountsFetches()).toBe(beforeCancel);
  });
});

describe('TransferPage — resumes an existing pending transfer', () => {
  const pendingAuthorization = {
    transferId: 'cccccccc-0000-4000-8000-00000000000c',
    type: 'internal' as const,
    amount: '77700',
    currency: 'MXN',
    sourceAccountId: SOURCE_ACCOUNT_ID,
    destinationAccountNumber: SEEDED_DESTINATION,
    destinationMaskedName: MASKED_NAME,
    payeeDisplayName: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    expiresAt: '2026-09-10T00:02:00.000Z',
  };

  it('jumps straight to the OTP confirm step when a pending exists on mount (no resolve needed)', async () => {
    server.use(
      http.get('/api/pending-authorization', () =>
        HttpResponse.json({ authorization: pendingAuthorization }),
      ),
    );

    renderTransferPage();

    // Resumed at confirm — the resolve form is skipped entirely, and the pending is shown FORMATTED.
    expect(await screen.findByLabelText(/one-time code/i)).toBeInTheDocument();
    expect(screen.getByText(/777\.00 MXN/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/destination account number/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('77700'); // raw minor units never rendered
  });

  it('recovers a concurrent PENDING_TRANSFER_CONFLICT by resuming the existing pending', async () => {
    // Pending feed is empty on mount (start at resolve), but initiate loses a single-pending race:
    // the page must refetch the pending and resume at confirm rather than dead-end on the 409.
    let conflictRaised = false;
    server.use(
      http.post('/api/transfers', () => {
        conflictRaised = true;
        return HttpResponse.json(
          {
            error: {
              code: 'PENDING_TRANSFER_CONFLICT',
              message: 'A pending transfer awaiting authorization already exists',
              requestId: 'req-conflict',
            },
          },
          { status: 409 },
        );
      }),
      http.get('/api/pending-authorization', () =>
        HttpResponse.json({ authorization: conflictRaised ? pendingAuthorization : null }),
      ),
    );

    renderTransferPage();

    fireEvent.change(await screen.findByLabelText(/destination account number/i), {
      target: { value: SEEDED_DESTINATION },
    });
    fireEvent.click(screen.getByRole('button', { name: /look up account/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, this is correct/i }));

    fireEvent.change(await screen.findByLabelText(/amount/i), { target: { value: '100.50' } });
    solveCaptcha();
    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);

    // Resumed onto the existing pending's confirm step.
    expect(await screen.findByLabelText(/one-time code/i)).toBeInTheDocument();
    expect(screen.getByText(/777\.00 MXN/)).toBeInTheDocument();
  });
});

/**
 * Focused, deterministic captcha-gating proof at the organism level (no network): initiate must be
 * blocked until BOTH a valid amount is entered AND the demo captcha is solved, and the amount handed
 * to initiate is the exact float-free MINOR-unit string — never the raw human input.
 */
describe('TransferAmountForm — captcha + amount gate initiate', () => {
  const payee: ResolvedPayee = {
    accountNumber: SEEDED_DESTINATION,
    maskedName: MASKED_NAME,
    currency: 'MXN',
    confirmationToken: 'tok',
  };
  const accounts: AccountDto[] = fixtureAccounts;

  function renderForm(onInitiate: (args: unknown) => void) {
    return render(
      <TransferAmountForm
        payee={payee}
        accounts={accounts}
        onInitiate={onInitiate as never}
        isInitiating={false}
        suspectedDuplicate={false}
      />,
    );
  }

  it('keeps Send disabled until amount is valid AND captcha solved, then submits minor units', () => {
    const onInitiate = vi.fn();
    renderForm(onInitiate);

    const send = screen.getByRole('button', { name: 'Send' });
    // Nothing entered yet.
    expect(send).toBeDisabled();

    // Valid amount alone is not enough — the captcha still gates it.
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '100.00' } });
    expect(send).toBeDisabled();
    // A click while disabled must not initiate.
    fireEvent.click(send);
    expect(onInitiate).not.toHaveBeenCalled();

    solveCaptcha();
    expect(send).toBeEnabled();

    fireEvent.click(send);
    expect(onInitiate).toHaveBeenCalledTimes(1);
    expect(onInitiate).toHaveBeenCalledWith({
      sourceAccountId: SOURCE_ACCOUNT_ID,
      amount: '10000', // 100.00 MXN → exact minor units, float-free
      confirmDuplicate: false,
    });
  });

  it('re-disables Send if the amount becomes invalid after the captcha is solved', () => {
    const onInitiate = vi.fn();
    renderForm(onInitiate);

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '100.00' } });
    solveCaptcha();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();

    // Over-precise amount is rejected by the float-free parser → Send blocked again.
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '1.005' } });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(onInitiate).not.toHaveBeenCalled();
  });

  it('renders source options with FORMATTED available balances, never raw minor units', () => {
    renderForm(vi.fn());
    const select = screen.getByLabelText(/from account/i);
    expect(within(select).getByText(/15,000\.00 MXN available/)).toBeInTheDocument();
    expect(select.textContent).not.toContain('1500000');
  });
});
