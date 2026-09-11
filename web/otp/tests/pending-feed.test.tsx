import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PendingFeed } from '../src/components/organisms/PendingFeed';
import type { PendingAuthorizationDto } from '../src/services/api/contracts/pending-authorization';

/**
 * The pending-authorization card is what the user reads before authorizing money movement, so
 * it must (a) FORMAT the amount (never leak the raw minor-unit integer), (b) render the
 * type-dependent destination and NOTHING from the other type's fields, and (c) show a live
 * countdown to the deadline. These render the real organism with hand-built DTOs; the expected
 * strings are hand-computed from the input + the es-MX/MXN rule.
 */

const FUTURE_EXPIRES = new Date(Date.now() + 90_000).toISOString();

const INTERNAL: PendingAuthorizationDto = {
  transferId: '33333333-3333-4333-8333-333333333333',
  type: 'internal',
  amount: '125000', // $1,250.00
  currency: 'MXN',
  sourceAccountId: '11111111-1111-4111-8111-111111111111',
  destinationAccountNumber: '1000000002',
  destinationMaskedName: 'Jua** Per**',
  payeeDisplayName: null,
  createdAt: '2026-09-10T18:00:00Z',
  expiresAt: FUTURE_EXPIRES,
};

const EXTERNAL: PendingAuthorizationDto = {
  transferId: '44444444-4444-4444-8444-444444444444',
  type: 'external_outbound',
  amount: '5000000', // $50,000.00
  currency: 'MXN',
  sourceAccountId: '11111111-1111-4111-8111-111111111111',
  destinationAccountNumber: null,
  destinationMaskedName: null,
  payeeDisplayName: 'Acme Utilities',
  createdAt: '2026-09-10T18:00:00Z',
  expiresAt: FUTURE_EXPIRES,
};

function renderFeed(authorization: PendingAuthorizationDto | null, isFetching = false) {
  const onRefresh = vi.fn();
  render(
    <PendingFeed authorization={authorization} isFetching={isFetching} onRefresh={onRefresh} />,
  );
  return { onRefresh };
}

describe('PendingFeed rendering', () => {
  it('renders an INTERNAL transfer: formatted amount, masked recipient + account number, no payee label', () => {
    renderFeed(INTERNAL);

    // Amount is FORMATTED with currency; the raw minor-unit integer must never appear.
    expect(screen.getByText('$1,250.00 MXN')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('125000');

    // Internal destination fields.
    expect(screen.getByText('1000000002')).toBeInTheDocument();
    expect(screen.getByText('Jua** Per**')).toBeInTheDocument();

    // The external-only label must NOT be present for an internal transfer.
    expect(screen.queryByText('Payee')).toBeNull();
    expect(screen.queryByText('Acme Utilities')).toBeNull();

    // Requested time is in Mexico City wall-clock (shifted from UTC), not a passthrough.
    expect(document.body.textContent).toContain('12:00:00');
    expect(document.body.textContent).toContain('GMT-6');
    expect(document.body.textContent).not.toContain('06:00:00');

    // A live m:ss countdown to the deadline is present.
    expect(screen.getByText(/^\d{1,2}:\d{2}$/)).toBeInTheDocument();
  });

  it('renders an EXTERNAL_OUTBOUND transfer: payee display name only, no masked-name / account-number', () => {
    renderFeed(EXTERNAL);

    expect(screen.getByText('$50,000.00 MXN')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('5000000');

    expect(screen.getByText('Acme Utilities')).toBeInTheDocument();

    // Internal-only rows must NOT render for an external transfer.
    expect(screen.queryByText('To account')).toBeNull();
    expect(screen.queryByText('Recipient')).toBeNull();
    expect(screen.queryByText('1000000002')).toBeNull();
    expect(screen.queryByText('Jua** Per**')).toBeNull();
  });

  it('renders a clear empty state (and no amount) when there is nothing pending', () => {
    renderFeed(null);

    expect(screen.getByText(/No pending authorization right now/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('$');
    expect(screen.queryByText(/^\d{1,2}:\d{2}$/)).toBeNull();
  });

  it('disables the refresh control (and shows a busy label) while a fetch is in flight', () => {
    renderFeed(INTERNAL, true);
    const button = screen.getByRole('button', { name: /refresh/i });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Refreshing…');
  });

  it('invokes the refresh callback when the refresh control is clicked', () => {
    const { onRefresh } = renderFeed(INTERNAL, false);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
