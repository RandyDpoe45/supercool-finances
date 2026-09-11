import { describeApiError } from '../../lib/apiError';
import type { AdminAccountDto } from '../../services/api/contracts/account';
import { Alert } from '../atoms/Alert';
import { Money } from '../atoms/Money';
import { StatusBadge } from '../atoms/StatusBadge';
import { Timestamp } from '../atoms/Timestamp';

/**
 * The admin accounts list as a table: owner, currency/kind, status badge, the three money fields
 * (balance / held / available via the float-free `Money` atom), when it was last updated, and a
 * per-row Freeze / Unfreeze action. A `frozen` account shows "Unfreeze"; any other status shows
 * "Freeze". The acting row's button is disabled while its mutation is in flight (`pendingId`), and a
 * failed mutation is surfaced via the `Alert` atom. Empty state is owned here; the page owns the
 * read query's loading/error and the mutation hooks.
 */
export function AccountsTable({
  accounts,
  onFreeze,
  onUnfreeze,
  pendingId,
  actionError,
}: {
  accounts: AdminAccountDto[];
  onFreeze: (id: string) => void;
  onUnfreeze: (id: string) => void;
  pendingId?: string;
  actionError?: unknown;
}) {
  if (accounts.length === 0) {
    return <p>No accounts.</p>;
  }
  return (
    <>
      {actionError !== undefined && (
        <Alert variant="error">Account action failed ({describeApiError(actionError)}).</Alert>
      )}
      <table aria-label="accounts" className="data-table">
        <thead>
          <tr>
            <th scope="col">Owner</th>
            <th scope="col">Account</th>
            <th scope="col">Status</th>
            <th scope="col">Balance</th>
            <th scope="col">Held</th>
            <th scope="col">Available</th>
            <th scope="col">Updated (Mexico City)</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => {
            const isFrozen = account.status === 'frozen';
            const isPending = pendingId === account.id;
            return (
              <tr key={account.id} data-account-id={account.id}>
                <td className="data-table__ref">{account.ownerId ?? '—'}</td>
                <td className="data-table__ref">
                  {account.accountNumber ?? account.id}
                  <span className="data-table__muted"> ({account.kind})</span>
                </td>
                <td>
                  <StatusBadge status={account.status} />
                </td>
                <td className="data-table__amount">
                  <Money amount={account.balance} currency={account.currency} />
                </td>
                <td className="data-table__amount">
                  <Money amount={account.held} currency={account.currency} />
                </td>
                <td className="data-table__amount">
                  <Money amount={account.available} currency={account.currency} />
                </td>
                <td>
                  <Timestamp iso={account.updatedAt} />
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={isPending}
                    onClick={() => (isFrozen ? onUnfreeze(account.id) : onFreeze(account.id))}
                  >
                    {isPending ? 'Working…' : isFrozen ? 'Unfreeze' : 'Freeze'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
