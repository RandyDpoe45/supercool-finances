import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User } from 'oidc-client-ts';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's node fetch cannot resolve the app's relative `/balance/admin` base; make the SAME
// same-origin base absolute against the test origin before baseApi captures the env at import
// (identical to the accounts / limits / whoami tests). MSW resolves its relative handlers against
// the same origin, so requests still match.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

// Importing the page registers transactionsApi + approvalsApi injected endpoints on baseApi.
import { ReversalsPage } from '../src/components/pages/ReversalsPage';
import { baseApi } from '../src/services/api/baseApi';
import { approvalsApi } from '../src/services/api/approvalsApi';
import { transactionsApi } from '../src/services/api/transactionsApi';
import type { AdminTransactionDto } from '../src/services/api/contracts/transaction';
import type { ApprovalRequestDto } from '../src/services/api/contracts/approval';
import { userManager } from '../src/auth/userManager';
import { server } from '../src/mocks/node';
import { fixtureWhoami } from '../src/mocks/fixtures/identity';
import {
  TX_INBOUND_POSTED,
  TX_INTERNAL_POSTED,
  TX_INTERNAL_PENDING,
  TX_INTERNAL_REVERSED,
  TX_OUTBOUND_POSTED,
} from '../src/mocks/fixtures/transactions';
import { APPROVAL_PENDING } from '../src/mocks/fixtures/approvals';

/**
 * Maker-checker reversals screen (Step A3) over a fresh store + live MSW stub + a REAL signed-in
 * session. Nothing here mocks the queries, the mutations, or the money helpers — these prove the
 * SPEC behaviors an operator relies on (spec 04 "Admin ops" + spec 07 admin-app), with the sharp,
 * money-safety-adjacent areas being:
 *
 *  - REVERSIBILITY GATING: a Reverse control is offered on EXACTLY the transactions the rule permits
 *    (POSTED && internal|external_inbound) — never on external_outbound, non-POSTED, or REVERSED;
 *  - FOUR-EYES: a maker cannot decide their OWN just-proposed reversal (403 SELF_APPROVAL_FORBIDDEN),
 *    and the target moves NO money;
 *  - a foreign-maker reversal a valid checker APPROVES executes atomically (target → REVERSED + a
 *    compensating tx appears + it leaves the queue), while REJECT discards it and moves no money.
 *
 * The reversibility rule is re-stated here FROM THE SPEC (not imported from the component under test),
 * so an implementation that offers Reverse on the wrong rows fails this suite.
 */

// The reversibility rule, per spec 04: a POSTED internal transfer OR a POSTED external_inbound credit.
const REVERSIBLE_TYPES = new Set(['internal', 'external_inbound']);
function contractReversible(tx: AdminTransactionDto): boolean {
  return tx.status === 'POSTED' && REVERSIBLE_TYPES.has(tx.type);
}

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

function makeStore() {
  // Fresh store per render so RTK Query's cache never bleeds across tests.
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

function renderPage() {
  return render(
    <Provider store={makeStore()}>
      <ReversalsPage />
    </Provider>,
  );
}

/**
 * Read the CURRENT stored transactions / approvals straight off the stub (a throwaway store, no
 * cache subscription). Because the admin stub state lives at MODULE scope and is shared, this
 * reflects any mutation a UI action just performed — the ground truth for the money-history proofs.
 */
async function fetchTransactions(): Promise<AdminTransactionDto[]> {
  const store = makeStore();
  const result = await store.dispatch(
    transactionsApi.endpoints.getTransactions.initiate(undefined, {
      subscribe: false,
      forceRefetch: true,
    }),
  );
  return result.data ?? [];
}

async function fetchPendingApprovals(): Promise<ApprovalRequestDto[]> {
  const store = makeStore();
  const result = await store.dispatch(
    approvalsApi.endpoints.getApprovals.initiate(undefined, {
      subscribe: false,
      forceRefetch: true,
    }),
  );
  return result.data ?? [];
}

/** Re-query a row fresh each time so assertions read post-re-render DOM, not a stale node. */
function txRowFor(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-transaction-id="${id}"]`);
  if (!row) {
    throw new Error(`transaction row ${id} not found`);
  }
  return row;
}

function approvalRowFor(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-approval-id="${id}"]`);
}

/** Locate the approval-queue row whose TARGET-transaction cell renders the given tx id (the target
 * uuid is unique per row), so a freshly-proposed approval can be found without knowing its id. */
function approvalRowByTarget(targetTxId: string): HTMLElement | null {
  const rows = document.querySelectorAll<HTMLElement>('table[aria-label="approvals"] tbody tr');
  for (const row of rows) {
    if (row.textContent?.includes(targetTxId)) {
      return row;
    }
  }
  return null;
}

/** The status a row's StatusBadge renders (via its `data-status`). */
function txStatus(id: string): string | null {
  return txRowFor(id).querySelector('[data-status]')?.getAttribute('data-status') ?? null;
}

beforeEach(async () => {
  await userManager.storeUser(
    new User({
      access_token: 'reversals-access-token',
      token_type: 'Bearer',
      session_state: null,
      scope: 'openid profile',
      expires_at: NOW_SECONDS() + 3600,
      profile: {
        sub: 'admin-subject-123',
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
});

describe('ReversalsPage — reversibility gating', () => {
  it('offers Reverse on EXACTLY the rows the rule permits (POSTED internal / external_inbound)', async () => {
    // Ground truth of what the stub serves, so the assertion adapts to the seed and cannot be gamed.
    const txs = await fetchTransactions();

    // Vacuity guards: the seed must exercise BOTH sides of the rule AND each non-reversible branch,
    // else a passing test would prove nothing.
    expect(txs.some(contractReversible), 'seed has a reversible tx').toBe(true);
    expect(
      txs.some((t) => t.type === 'external_outbound' && t.status === 'POSTED'),
      'seed has a POSTED external_outbound (not reversible)',
    ).toBe(true);
    expect(
      txs.some((t) => t.status === 'PENDING'),
      'seed has a non-POSTED tx',
    ).toBe(true);
    expect(
      txs.some((t) => t.status === 'REVERSED'),
      'seed has a REVERSED tx',
    ).toBe(true);

    renderPage();
    await screen.findByRole('table', { name: 'transactions' });

    for (const tx of txs) {
      const reverse = within(txRowFor(tx.id)).queryByRole('button', { name: 'Reverse' });
      if (contractReversible(tx)) {
        expect(
          reverse,
          `expected Reverse on ${tx.type}/${tx.status} (${tx.id})`,
        ).toBeInTheDocument();
      } else {
        expect(
          reverse,
          `expected NO Reverse on ${tx.type}/${tx.status} (${tx.id})`,
        ).not.toBeInTheDocument();
      }
    }
  });

  it('names the non-reversible seed rows concretely: external_outbound / PENDING / REVERSED show no Reverse', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'transactions' });

    // A reversible POSTED internal and a reversible POSTED external_inbound DO offer Reverse.
    expect(
      within(txRowFor(TX_INTERNAL_POSTED)).getByRole('button', { name: 'Reverse' }),
    ).toBeInTheDocument();
    expect(
      within(txRowFor(TX_INBOUND_POSTED)).getByRole('button', { name: 'Reverse' }),
    ).toBeInTheDocument();

    // The three non-reversible branches do NOT.
    for (const id of [TX_OUTBOUND_POSTED, TX_INTERNAL_PENDING, TX_INTERNAL_REVERSED]) {
      expect(
        within(txRowFor(id)).queryByRole('button', { name: 'Reverse' }),
      ).not.toBeInTheDocument();
    }
  });
});

describe('ReversalsPage — propose a reversal (maker action)', () => {
  it('proposes a reversal with a reason; the new PENDING approval (maker = self) appears in the queue', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'transactions' });

    // Baseline: no PENDING approval yet targets the reversible inbound credit.
    const before = await fetchPendingApprovals();
    expect(before.some((a) => a.targetTransactionId === TX_INBOUND_POSTED)).toBe(false);

    fireEvent.click(within(txRowFor(TX_INBOUND_POSTED)).getByRole('button', { name: 'Reverse' }));

    // The inline reason-capture form appears; enter an optional reason and confirm.
    const reason = await screen.findByLabelText(/reason \(optional\)/i);
    fireEvent.change(reason, { target: { value: 'duplicate inbound credit' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm reversal/i }));

    // After the mutation + Approval-LIST invalidation refetch, the queue shows a PENDING approval for
    // THIS target, proposed by the logged-in admin (self). If invalidation were missing this fails.
    await screen.findByRole('table', { name: 'approvals' });
    await waitFor(() => expect(approvalRowByTarget(TX_INBOUND_POSTED)).not.toBeNull());
    const row = approvalRowByTarget(TX_INBOUND_POSTED)!;
    expect(within(row).getByText('PENDING')).toBeInTheDocument();
    expect(within(row).getByText(fixtureWhoami.userId)).toBeInTheDocument(); // maker = self

    // Ground truth: exactly one MORE pending approval than before, targeting this tx, maker = self.
    const after = await fetchPendingApprovals();
    expect(after.length).toBe(before.length + 1);
    const created = after.find((a) => a.targetTransactionId === TX_INBOUND_POSTED);
    expect(created).toBeDefined();
    expect(created!.status).toBe('PENDING');
    expect(created!.makerId).toBe(fixtureWhoami.userId);
    // No error surfaced on the happy path.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ReversalsPage — four-eyes: a maker cannot decide their own proposal', () => {
  it('surfaces SELF_APPROVAL_FORBIDDEN when approving your OWN reversal, and moves no money', async () => {
    renderPage();
    await screen.findByRole('table', { name: 'transactions' });

    // Propose as self (no reason), then find the self-made PENDING approval in the queue.
    fireEvent.click(within(txRowFor(TX_INBOUND_POSTED)).getByRole('button', { name: 'Reverse' }));
    await screen.findByLabelText(/reason \(optional\)/i);
    fireEvent.click(screen.getByRole('button', { name: /confirm reversal/i }));

    await screen.findByRole('table', { name: 'approvals' });
    await waitFor(() => expect(approvalRowByTarget(TX_INBOUND_POSTED)).not.toBeNull());
    const selfRow = approvalRowByTarget(TX_INBOUND_POSTED)!;
    expect(within(selfRow).getByText(fixtureWhoami.userId)).toBeInTheDocument(); // maker = self

    // Attempt to approve your own proposal — the server rejects it (four-eyes).
    fireEvent.click(within(selfRow).getByRole('button', { name: 'Approve' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/approval action failed/i);
    expect(alert).toHaveTextContent(/SELF_APPROVAL_FORBIDDEN/);

    // Money-safety: nothing moved. The target stays POSTED, there is NO compensating tx, and the
    // approval remains PENDING (read straight off the stub).
    const txs = await fetchTransactions();
    expect(txs.find((t) => t.id === TX_INBOUND_POSTED)!.status).toBe('POSTED');
    expect(txs.some((t) => t.reversesTransactionId === TX_INBOUND_POSTED)).toBe(false);
    const pendings = await fetchPendingApprovals();
    const still = pendings.find((a) => a.targetTransactionId === TX_INBOUND_POSTED);
    expect(still).toBeDefined();
    expect(still!.status).toBe('PENDING');
  });
});

describe('ReversalsPage — checker approves a foreign-maker reversal (executes)', () => {
  it('flips the target to REVERSED, adds a compensating tx, and removes the approval from the queue', async () => {
    renderPage();
    const txTable = await screen.findByRole('table', { name: 'transactions' });
    await screen.findByRole('table', { name: 'approvals' });

    // Precondition: the seed approval (maker = admin-user-2 ≠ self) targets a POSTED internal tx with
    // no compensating tx yet.
    expect(txStatus(TX_INTERNAL_POSTED)).toBe('POSTED');
    const txCountBefore = txTable.querySelectorAll('tbody tr').length;
    expect(approvalRowFor(APPROVAL_PENDING)).not.toBeNull();

    fireEvent.click(
      within(approvalRowFor(APPROVAL_PENDING)!).getByRole('button', { name: 'Approve' }),
    );

    // 1) The target flips POSTED → REVERSED (Transaction-LIST invalidation → refetch).
    await waitFor(() => expect(txStatus(TX_INTERNAL_POSTED)).toBe('REVERSED'));
    // 2) The approval leaves the pending queue (Approval-LIST invalidation → refetch of PENDING).
    await waitFor(() => expect(approvalRowFor(APPROVAL_PENDING)).toBeNull());
    // 3) A compensating tx appears — exactly one more row than before.
    await waitFor(() =>
      expect(
        screen.getByRole('table', { name: 'transactions' }).querySelectorAll('tbody tr').length,
      ).toBe(txCountBefore + 1),
    );

    // The compensating tx is a POSTED movement linked back to the reversed target.
    const txs = await fetchTransactions();
    const compensating = txs.find((t) => t.reversesTransactionId === TX_INTERNAL_POSTED);
    expect(compensating).toBeDefined();
    expect(compensating!.status).toBe('POSTED');
    expect(compensating!.id).not.toBe(TX_INTERNAL_POSTED);
    // Happy path: no error banner.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ReversalsPage — checker rejects a foreign-maker reversal (no money moves)', () => {
  it('removes the approval from the queue and leaves the target POSTED with no compensating tx', async () => {
    renderPage();
    const txTable = await screen.findByRole('table', { name: 'transactions' });
    await screen.findByRole('table', { name: 'approvals' });

    expect(txStatus(TX_INTERNAL_POSTED)).toBe('POSTED');
    const txCountBefore = txTable.querySelectorAll('tbody tr').length;

    fireEvent.click(
      within(approvalRowFor(APPROVAL_PENDING)!).getByRole('button', { name: 'Reject' }),
    );

    // The rejected approval leaves the pending queue...
    await waitFor(() => expect(approvalRowFor(APPROVAL_PENDING)).toBeNull());

    // ...but NO money moved: the target is still POSTED, the row count is unchanged (no compensating
    // tx was added), and the stub confirms no reversal link exists.
    expect(txStatus(TX_INTERNAL_POSTED)).toBe('POSTED');
    expect(
      screen.getByRole('table', { name: 'transactions' }).querySelectorAll('tbody tr').length,
    ).toBe(txCountBefore);
    const txs = await fetchTransactions();
    expect(txs.find((t) => t.id === TX_INTERNAL_POSTED)!.status).toBe('POSTED');
    expect(txs.some((t) => t.reversesTransactionId === TX_INTERNAL_POSTED)).toBe(false);
  });
});

describe('ReversalsPage — loading + error states of the two reads', () => {
  it('renders both sections (transactions + approvals) when data is present, with no error', async () => {
    renderPage();
    expect(await screen.findByRole('table', { name: 'transactions' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'approvals' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Transactions' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pending approvals' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a transactions read failure as an alert and renders no transactions table', async () => {
    server.use(
      http.get('/balance/admin/transactions', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );
    renderPage();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /failed to load transactions/i.test(a.textContent ?? ''))).toBe(true);
    expect(screen.queryByRole('table', { name: 'transactions' })).not.toBeInTheDocument();
    // The approvals section is independent and still renders.
    expect(await screen.findByRole('table', { name: 'approvals' })).toBeInTheDocument();
  });

  it('surfaces an approvals read failure as an alert and renders no approvals table', async () => {
    server.use(
      http.get('/balance/admin/approvals', () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } },
          { status: 500 },
        ),
      ),
    );
    renderPage();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /failed to load approvals/i.test(a.textContent ?? ''))).toBe(true);
    expect(screen.queryByRole('table', { name: 'approvals' })).not.toBeInTheDocument();
    // The transactions section is independent and still renders.
    expect(await screen.findByRole('table', { name: 'transactions' })).toBeInTheDocument();
  });
});
