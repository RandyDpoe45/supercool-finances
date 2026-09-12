import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDto } from '../src/services/api/contracts/accounts';
import { AccountsList } from '../src/components/organisms/AccountsList';

/**
 * Copy-account-number affordance on each account card (CopyButton atom).
 *
 * The real invariant is what lands on the clipboard: clicking a card's copy control must
 * write THAT card's own identifier (`accountNumber ?? id`) — never a shared, wrong or stale
 * value — and the button's accessible name must stay "Copy account number" while only the
 * visible affordance toggles to "Copied". jsdom has no Clipboard API, so we stub
 * `navigator.clipboard.writeText` with a spy and assert on its call args (the behavior),
 * not on classes/styles (css:false — style assertions would prove nothing).
 *
 * Tests go through AccountsList (the real composition of multiple AccountCards) so a bug
 * that copied a neighbour's number, or a single shared value, cannot pass.
 */

const ACCT_A: AccountDto = {
  id: '11111111-1111-4111-8111-111111111111',
  currency: 'MXN',
  status: 'active',
  kind: 'customer',
  balance: '1500000',
  held: '0',
  available: '1500000',
  accountNumber: '1000000001',
  label: 'Everyday',
};

const ACCT_B: AccountDto = {
  id: '22222222-2222-4222-8222-222222222222',
  currency: 'MXN',
  status: 'active',
  kind: 'customer',
  balance: '250075',
  held: '5000',
  available: '245075',
  accountNumber: '1000000002',
  label: 'Rainy Day',
};

// A (system-style) account with NO number — the card must fall back to the id.
const ACCT_NO_NUMBER: AccountDto = {
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

const COPY_LABEL = 'Copy account number';

let writeText: ReturnType<typeof vi.fn>;

function stubClipboard(value: { writeText: unknown } | undefined): void {
  Object.defineProperty(navigator, 'clipboard', {
    value,
    configurable: true,
    writable: true,
  });
}

function renderList(accounts: AccountDto[]) {
  return render(
    <MemoryRouter>
      <AccountsList accounts={accounts} />
    </MemoryRouter>,
  );
}

function cardFor(account: AccountDto): HTMLElement {
  const identifier = account.accountNumber ?? account.id;
  const list = screen.getByRole('list', { name: 'accounts' });
  const item = within(list)
    .getAllByRole('listitem')
    .find((li) => li.textContent?.includes(identifier));
  if (!item) throw new Error(`no card rendered for ${identifier}`);
  return item;
}

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  stubClipboard({ writeText });
});

afterEach(() => {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'clipboard');
  vi.clearAllMocks();
});

describe('copy account number', () => {
  it('copies each card its OWN account number — not a shared, wrong or stale value', async () => {
    renderList([ACCT_A, ACCT_B]);

    // Card A copies A's number.
    fireEvent.click(within(cardFor(ACCT_A)).getByRole('button', { name: COPY_LABEL }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith('1000000001');

    // Card B copies B's DIFFERENT number — the value is per-card, not shared.
    fireEvent.click(within(cardFor(ACCT_B)).getByRole('button', { name: COPY_LABEL }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenLastCalledWith('1000000002');

    // And every recorded write was one of the two exact numbers — nothing else leaked.
    expect(writeText.mock.calls.flat()).toEqual(['1000000001', '1000000002']);
  });

  it('falls back to the account id when the account has no number', async () => {
    renderList([ACCT_NO_NUMBER]);

    fireEvent.click(within(cardFor(ACCT_NO_NUMBER)).getByRole('button', { name: COPY_LABEL }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenLastCalledWith(ACCT_NO_NUMBER.id);
  });

  it('exposes a "Copy account number" control on every card, queryable by accessible name', () => {
    renderList([ACCT_A, ACCT_B]);

    // One control per card, each reachable by its stable accessible name (aria-label),
    // not by CSS class.
    expect(screen.getAllByRole('button', { name: COPY_LABEL })).toHaveLength(2);
  });

  it('shows the transient "Copied" affordance while keeping the accessible name stable', async () => {
    renderList([ACCT_A]);

    const button = screen.getByRole('button', { name: COPY_LABEL });
    expect(within(button).getByText('Copy')).toBeInTheDocument();

    fireEvent.click(button);

    // Visible affordance flips to "Copied" only after the write resolves.
    await within(button).findByText('Copied');

    // The accessible name must NOT mutate to "Copied" — it stays the stable label, so the
    // control is still found by the same name (assistive tech / tests never see it change).
    expect(screen.getByRole('button', { name: COPY_LABEL })).toBe(button);
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });

  it('resets from "Copied" back to "Copy" after the transient window', async () => {
    vi.useFakeTimers();
    try {
      renderList([ACCT_A]);
      const button = screen.getByRole('button', { name: COPY_LABEL });

      fireEvent.click(button);
      // Flush the awaited clipboard write + the resulting state update.
      await act(async () => {
        await Promise.resolve();
      });
      expect(within(button).getByText('Copied')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(within(button).getByText('Copy')).toBeInTheDocument();
      expect(within(button).queryByText('Copied')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw or show "Copied" when the Clipboard API is unavailable', async () => {
    stubClipboard(undefined);
    renderList([ACCT_A]);

    const button = screen.getByRole('button', { name: COPY_LABEL });
    expect(() => fireEvent.click(button)).not.toThrow();

    // The guard returns early: no write, no transient state.
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(button).getByText('Copy')).toBeInTheDocument();
    expect(within(button).queryByText('Copied')).not.toBeInTheDocument();
  });

  it('does not throw or show "Copied" when the clipboard write is REJECTED (API present but denied)', async () => {
    // Distinct from the "unavailable" guard: here `writeText` exists but rejects (e.g. the
    // document isn't focused / permission denied). The write is attempted, then rejects.
    const rejectingWrite = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    stubClipboard({ writeText: rejectingWrite });

    renderList([ACCT_A]);
    const button = screen.getByRole('button', { name: COPY_LABEL });

    // The click's handler must swallow the rejection — it neither throws synchronously...
    expect(() => fireEvent.click(button)).not.toThrow();

    // ...nor as an unhandled rejection: awaiting/flushing here would surface one and fail
    // the run. The write was attempted with the correct value.
    await waitFor(() => expect(rejectingWrite).toHaveBeenCalledTimes(1));
    expect(rejectingWrite).toHaveBeenLastCalledWith('1000000001');

    await act(async () => {
      await Promise.resolve();
    });

    // The "Copied" state advances ONLY on a successful write — a rejected write must leave
    // the affordance and the accessible name untouched.
    expect(within(button).getByText('Copy')).toBeInTheDocument();
    expect(within(button).queryByText('Copied')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: COPY_LABEL })).toBe(button);
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
  });
});
