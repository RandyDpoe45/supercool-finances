import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { AccountDto } from '../src/services/api/contracts/accounts';
import { AccountsList } from '../src/components/organisms/AccountsList';

/**
 * The accounts overview must show balance / held / available FORMATTED (float-free), never
 * the raw minor-unit strings. The fixture below is chosen so all three differ, so a bug that
 * showed one field's value for another, or that leaked raw units, cannot pass. Expected
 * strings are HAND-COMPUTED (MXN exponent 2), not taken from lib/money.
 */

// balance 2,500.75 / held 50.00 / available 2,450.75 — all distinct.
const account: AccountDto = {
  id: '33333333-3333-4333-8333-333333333333',
  currency: 'MXN',
  status: 'active',
  kind: 'customer',
  balance: '250075',
  held: '5000',
  available: '245075',
  accountNumber: '1000000009',
  label: 'Primary Checking',
};

function renderList(accounts: AccountDto[]) {
  return render(
    <MemoryRouter>
      <AccountsList accounts={accounts} />
    </MemoryRouter>,
  );
}

describe('AccountsList — overview formatting', () => {
  it('renders balance/held/available formatted, with raw minor units never in the DOM', () => {
    renderList([account]);

    const list = screen.getByRole('list', { name: 'accounts' });
    const item = within(list).getByRole('listitem');

    // Each of the three money fields shows its own hand-computed formatted value.
    expect(item.textContent).toContain('2,500.75'); // balance  250075
    expect(item.textContent).toContain('50.00'); // held     5000
    expect(item.textContent).toContain('2,450.75'); // available 245075

    // Raw minor-unit strings must never be visible / screen-reader text.
    expect(item.textContent).not.toContain('250075');
    expect(item.textContent).not.toContain('245075');
    // held raw '5000' must not appear as contiguous text anywhere in the card.
    expect(item.textContent).not.toContain('5000');

    // Currency and status are surfaced.
    expect(item.textContent).toContain('MXN');
    expect(within(item).getByText('active')).toBeInTheDocument();

    // The customer-supplied account name is surfaced alongside the money fields.
    expect(within(item).getByText('Primary Checking')).toBeInTheDocument();
  });

  it('links each account to its statement route (selecting an account opens history)', () => {
    renderList([account]);

    const link = screen.getByRole('link', { name: account.accountNumber ?? account.id });
    expect(link).toHaveAttribute('href', `/accounts/${account.id}/transactions`);
  });

  it('shows an empty state instead of an empty list when there are no accounts', () => {
    renderList([]);

    expect(screen.getByText('No accounts.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'accounts' })).not.toBeInTheDocument();
  });
});
