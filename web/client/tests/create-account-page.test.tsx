import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's node fetch cannot resolve the app's relative `/balance/api` base; make the same-origin base
// absolute before baseApi captures the env at import (identical to the other page tests). MSW still
// matches its relative handlers against the same origin.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/api`);
});

import { CreateAccountPage } from '../src/components/pages/CreateAccountPage';
import { CreateAccountForm } from '../src/components/organisms/CreateAccountForm';
import { AccountsPage } from '../src/components/pages/AccountsPage';
import { AccountsList } from '../src/components/organisms/AccountsList';
import { accountsApi } from '../src/services/api/accountsApi';
import { baseApi } from '../src/services/api/baseApi';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import {
  createAccount as seedCreatedAccount,
  listCreatedAccounts,
  resetAccountStore,
  serializeAccountDto,
} from '../src/mocks/state/accountStore';
import { projectAccounts } from '../src/mocks/state/transferStore';
import { fixtureAccounts } from '../src/mocks/fixtures/accounts';
import type { AccountDto } from '../src/services/api/contracts/accounts';

/**
 * The create-account journey over a fresh store + live MSW + a REAL signed-in session (so the RTK
 * Query bearer is attached exactly as in production). Nothing mocks the mutation, the money helpers,
 * or the error mapping. These prove the spec-07 create-account behaviors as the user experiences them:
 *
 *  - the happy path: name → submit → navigate to the accounts list → the new account appears at a
 *    ZERO balance (the money-safety proof: a freshly opened account holds nothing);
 *  - the cap (422 ACCOUNT_LIMIT_REACHED) shows the FRIENDLY, code-keyed message and does NOT navigate;
 *  - a generic failure falls back to the transport phrase (proves the page is not 422-only);
 *  - the form gates submit until the label is valid and surfaces field errors, trimming before it
 *    hands the label up;
 *  - the "New account" entry point on the overview routes to the create page;
 *  - the mutation posts EXACTLY `{ label }` and invalidates the accounts LIST so the overview refetches;
 *  - the account card renders the label.
 */

const SEEDED_ACCOUNTS = fixtureAccounts.length;
const MAX_ACCOUNTS_PER_CUSTOMER = 5;
const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

/** Mount the create page AND the accounts overview so a successful create's navigate('/') is
 * observable — the overview renders and the new account must appear in the live-fetched list. */
function renderCreateFlow(entry = '/accounts/new') {
  return render(
    <Provider store={makeStore()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/" element={<AccountsPage />} />
          <Route path="/accounts/new" element={<CreateAccountPage />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

beforeEach(async () => {
  resetAccountStore();
  await userManager.storeUser(
    new User({
      access_token: 'create-account-token',
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
  resetAccountStore();
});

describe('CreateAccountPage — happy path', () => {
  it('submits a name, navigates to the overview, and the new account appears at a zero balance', async () => {
    renderCreateFlow();

    // Start on the create page.
    expect(screen.getByRole('heading', { name: /open a new account/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/account name/i), {
      target: { value: 'Vacation Fund' },
    });
    const create = screen.getByRole('button', { name: /create account/i });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);

    // Navigated to the accounts overview.
    expect(await screen.findByRole('heading', { name: /your accounts/i })).toBeInTheDocument();

    // The new account is in the live-fetched list — found by its label.
    const list = await screen.findByRole('list', { name: 'accounts' });
    const card = within(list)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('Vacation Fund'));
    expect(card).toBeDefined();

    // Money-safety: a freshly opened account holds nothing — balance/held/available all read 0.00,
    // and it is a live, active customer account.
    expect(card!.textContent).toContain('0.00');
    expect(within(card!).getByText('active')).toBeInTheDocument();
    // The seeded accounts are still present — the create appended, it did not replace.
    expect(within(list).getAllByRole('listitem')).toHaveLength(SEEDED_ACCOUNTS + 1);
  });
});

describe('CreateAccountPage — account limit (422) and generic failure', () => {
  it('shows the friendly cap message on 422 and does NOT navigate away', async () => {
    // Fill the store to the cap so the page's create collides.
    for (let i = 0; i < MAX_ACCOUNTS_PER_CUSTOMER - SEEDED_ACCOUNTS; i += 1) {
      seedCreatedAccount({ label: `Filler ${i}` });
    }

    renderCreateFlow();
    fireEvent.change(screen.getByLabelText(/account name/i), { target: { value: 'One Too Many' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    // The code-keyed, human message is surfaced (never the raw envelope).
    expect(await screen.findByText(/reached the maximum number of accounts/i)).toBeInTheDocument();
    // The generic fallback must NOT be shown — the page branched on the domain code.
    expect(screen.queryByText(/could not create the account/i)).not.toBeInTheDocument();

    // No navigation: still on the create page, the overview never rendered.
    expect(screen.getByRole('heading', { name: /open a new account/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /your accounts/i })).not.toBeInTheDocument();
  });

  it('falls back to the generic transport message on a non-domain failure, and does not navigate', async () => {
    server.use(
      http.post('/balance/api/accounts', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'boom', requestId: 'req-1' } },
          { status: 500 },
        ),
      ),
    );

    renderCreateFlow();
    fireEvent.change(screen.getByLabelText(/account name/i), {
      target: { value: 'Vacation Fund' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(await screen.findByText(/could not create the account/i)).toBeInTheDocument();
    // The cap message must NOT appear for a non-cap error.
    expect(screen.queryByText(/reached the maximum number of accounts/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /open a new account/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /your accounts/i })).not.toBeInTheDocument();
  });
});

describe('CreateAccountForm — submit gating, field errors, trimming', () => {
  it('keeps Create disabled until a valid label is entered; a disabled click submits nothing', () => {
    const onCreate = vi.fn();
    render(<CreateAccountForm onCreate={onCreate} isCreating={false} />);

    const create = screen.getByRole('button', { name: /create account/i });
    const input = screen.getByLabelText(/account name/i);
    expect(create).toBeDisabled();

    // A whitespace-only label trims to nothing → still invalid; a blur surfaces the field error.
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(create).toBeDisabled();
    expect(screen.getByText(/enter a name \(1–50 characters\)/i)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');

    // A disabled Create must not fire the mutation.
    fireEvent.click(create);
    expect(onCreate).not.toHaveBeenCalled();

    // A valid label enables Create and clears the field error.
    fireEvent.change(input, { target: { value: 'Vacation' } });
    expect(create).toBeEnabled();
    expect(screen.queryByText(/enter a name \(1–50 characters\)/i)).not.toBeInTheDocument();

    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({ label: 'Vacation' });
  });

  it('trims the label before handing it up (never the raw padded input)', () => {
    const onCreate = vi.fn();
    render(<CreateAccountForm onCreate={onCreate} isCreating={false} />);

    fireEvent.change(screen.getByLabelText(/account name/i), {
      target: { value: '  Rainy Day  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(onCreate).toHaveBeenCalledWith({ label: 'Rainy Day' });
  });

  it('rejects an over-long label but accepts the 50-char boundary', () => {
    const onCreate = vi.fn();
    render(<CreateAccountForm onCreate={onCreate} isCreating={false} />);

    const input = screen.getByLabelText(/account name/i);
    const create = screen.getByRole('button', { name: /create account/i });

    fireEvent.change(input, { target: { value: 'a'.repeat(51) } });
    expect(create).toBeDisabled();
    fireEvent.click(create);
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'a'.repeat(50) } });
    expect(create).toBeEnabled();
  });

  it('surfaces the server error and blocks submit while a create is in flight', () => {
    const onCreate = vi.fn();
    const { rerender } = render(
      <CreateAccountForm onCreate={onCreate} isCreating={false} serverError="Server said no." />,
    );
    expect(screen.getByText('Server said no.')).toBeInTheDocument();

    // While creating, a valid label must still NOT submit — the guard prevents a double-open.
    rerender(<CreateAccountForm onCreate={onCreate} isCreating={true} />);
    fireEvent.change(screen.getByLabelText(/account name/i), { target: { value: 'Vacation' } });
    const create = screen.getByRole('button', { name: /creating/i });
    expect(create).toBeDisabled();
    fireEvent.click(create);
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe('AccountsPage — "New account" entry point', () => {
  it('links to /accounts/new and navigating there opens the create form', async () => {
    renderCreateFlow('/');

    const link = await screen.findByRole('link', { name: /new account/i });
    expect(link).toHaveAttribute('href', '/accounts/new');

    fireEvent.click(link);
    expect(await screen.findByRole('heading', { name: /open a new account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/account name/i)).toBeInTheDocument();
  });
});

describe('AccountCard — renders the customer label', () => {
  const labelled: AccountDto = {
    id: '11111111-1111-4111-8111-111111111111',
    currency: 'MXN',
    status: 'active',
    kind: 'customer',
    balance: '1500000',
    held: '0',
    available: '1500000',
    accountNumber: '1000000001',
    label: 'Primary Checking',
  };
  // A system account with no name — the card must render no label element for it.
  const unlabelled: AccountDto = {
    id: '99999999-9999-4999-8999-999999999999',
    currency: 'MXN',
    status: 'active',
    kind: 'system',
    balance: '0',
    held: '0',
    available: '0',
    accountNumber: null,
    label: null,
  };

  it('shows the label alongside the account number when present, and nothing when absent', () => {
    render(
      <MemoryRouter>
        <AccountsList accounts={[labelled, unlabelled]} />
      </MemoryRouter>,
    );

    const list = screen.getByRole('list', { name: 'accounts' });
    const items = within(list).getAllByRole('listitem');
    const labelledCard = items.find((li) => li.textContent?.includes(labelled.accountNumber!))!;
    const unlabelledCard = items.find((li) => li.textContent?.includes(unlabelled.id))!;

    // The labelled card shows BOTH its number (link) and its distinct label — one did not replace
    // the other.
    expect(
      within(labelledCard).getByRole('link', { name: labelled.accountNumber! }),
    ).toBeInTheDocument();
    expect(within(labelledCard).getByText('Primary Checking')).toBeInTheDocument();

    // The label is per-card (not shared/leaked): it appears exactly once, and not on the
    // unlabelled card.
    expect(screen.getAllByText('Primary Checking')).toHaveLength(1);
    expect(unlabelledCard.textContent).not.toContain('Primary Checking');
  });
});

/**
 * The RTK Query mutation wiring, driven through the REAL store + REAL MSW stub. These are the
 * "does the cache do the right thing" proofs the page path alone cannot make (a fresh page mount
 * fetches regardless of the tag).
 */
describe('useCreateAccountMutation — posts { label } and invalidates the accounts LIST', () => {
  /** Count GET /accounts hits while serving the LIVE combined list, so a refetch is observable AND
   * the refetched numbers stay coherent with the created account. */
  function countAccountsFetches(): () => number {
    let count = 0;
    server.use(
      http.get('/balance/api/accounts', () => {
        count += 1;
        return HttpResponse.json({
          accounts: [...projectAccounts(), ...listCreatedAccounts().map(serializeAccountDto)],
        });
      }),
    );
    return () => count;
  }

  it('refetches the list after a create so the new (zero-balance) account appears', async () => {
    const fetches = countAccountsFetches();
    const store = makeStore();

    // A live subscription that must outlive the mutation (so an invalidation actually refetches).
    store.dispatch(accountsApi.endpoints.getAccounts.initiate());
    await waitFor(() => expect(fetches()).toBeGreaterThanOrEqual(1));
    const before = fetches();
    const selectAccounts = () =>
      accountsApi.endpoints.getAccounts.select()(store.getState()).data as AccountDto[] | undefined;
    expect(selectAccounts()).toHaveLength(SEEDED_ACCOUNTS);

    await store
      .dispatch(accountsApi.endpoints.createAccount.initiate({ label: 'Vacation Fund' }))
      .unwrap();

    // LIST invalidation forced a refetch, and the cached list now includes the new account.
    await waitFor(() => expect(selectAccounts()).toHaveLength(SEEDED_ACCOUNTS + 1));
    expect(fetches()).toBeGreaterThan(before);

    const created = selectAccounts()!.find((a) => a.label === 'Vacation Fund');
    expect(created).toBeDefined();
    expect(created!.balance).toBe('0');
    expect(created!.held).toBe('0');
    expect(created!.available).toBe('0');
  });

  it('sends EXACTLY { label } on the wire — no smuggled server-owned fields', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post('/balance/api/accounts', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            id: 'aaaaaaaa-0000-4000-8000-000000000001',
            currency: 'MXN',
            status: 'active',
            kind: 'customer',
            balance: '0',
            held: '0',
            available: '0',
            accountNumber: '3000000009',
            label: captured.label,
          },
          { status: 201 },
        );
      }),
    );

    const store = makeStore();
    await store
      .dispatch(accountsApi.endpoints.createAccount.initiate({ label: 'Vacation Fund' }))
      .unwrap();

    expect(captured).toBeDefined();
    expect(Object.keys(captured!)).toEqual(['label']);
    expect(captured).toEqual({ label: 'Vacation Fund' });
  });
});
