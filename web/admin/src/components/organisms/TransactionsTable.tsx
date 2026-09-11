import { describeApiError } from '../../lib/apiError';
import type { AdminTransactionDto } from '../../services/api/contracts/transaction';
import { Alert } from '../atoms/Alert';
import { Money } from '../atoms/Money';
import { StatusBadge } from '../atoms/StatusBadge';
import { Timestamp } from '../atoms/Timestamp';

/**
 * Whether a transaction is admin-reversible via maker-checker. Mirrors the balance-service rule
 * VERBATIM: the target must be `POSTED` AND its type must be `internal` or `external_inbound`. An
 * `external_outbound` transfer is NOT admin-reversible (its reversal is the rail-failure callback
 * path), and a non-POSTED / already-REVERSED transaction is not reversible. The server re-checks and
 * 409s (`TRANSACTION_NOT_REVERSIBLE`) if the rule is violated, so this only decides whether to OFFER
 * the action.
 */
// Deliberately colocated with the table (the page reuses it); a pure, HMR-safe non-component export.
// eslint-disable-next-line react-refresh/only-export-components
export function isReversible(tx: AdminTransactionDto): boolean {
  return tx.status === 'POSTED' && (tx.type === 'internal' || tx.type === 'external_inbound');
}

/**
 * The admin transactions list as a table: id + type, a status badge, the amount (via the float-free
 * `Money` atom), both account legs, who initiated it, and when it was created (Mexico City). Only a
 * REVERSIBLE row (see {@link isReversible}) shows a **Reverse** button; non-reversible rows render an
 * em-dash. The acting row's button disables while its proposal is in flight (`reversingId`), and a
 * failed action surfaces via the `Alert` atom. Empty state is owned here; the page owns the read
 * query's loading/error, the reason-capture interaction, and the mutation hooks.
 */
export function TransactionsTable({
  transactions,
  onReverse,
  reversingId,
  actionError,
}: {
  transactions: AdminTransactionDto[];
  onReverse: (id: string) => void;
  reversingId?: string;
  actionError?: unknown;
}) {
  if (transactions.length === 0) {
    return <p>No transactions.</p>;
  }
  return (
    <>
      {actionError !== undefined && (
        <Alert variant="error">Reversal action failed ({describeApiError(actionError)}).</Alert>
      )}
      <table aria-label="transactions" className="data-table">
        <thead>
          <tr>
            <th scope="col">Transaction</th>
            <th scope="col">Status</th>
            <th scope="col">Amount</th>
            <th scope="col">Debit account</th>
            <th scope="col">Credit account</th>
            <th scope="col">Initiated by</th>
            <th scope="col">Created (Mexico City)</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => {
            const reversible = isReversible(tx);
            const isPending = reversingId === tx.id;
            return (
              <tr key={tx.id} data-transaction-id={tx.id}>
                <td className="data-table__ref">
                  {tx.id}
                  <span className="data-table__muted"> ({tx.type})</span>
                </td>
                <td>
                  <StatusBadge status={tx.status} />
                </td>
                <td className="data-table__amount">
                  <Money amount={tx.amount} currency={tx.currency} showCode />
                </td>
                <td className="data-table__ref">{tx.debitAccountId ?? '—'}</td>
                <td className="data-table__ref">{tx.creditAccountId ?? '—'}</td>
                <td className="data-table__ref">{tx.initiatedBy}</td>
                <td>
                  <Timestamp iso={tx.createdAt} />
                </td>
                <td>
                  {reversible ? (
                    <button
                      type="button"
                      className="btn btn--secondary"
                      disabled={isPending}
                      onClick={() => onReverse(tx.id)}
                    >
                      {isPending ? 'Working…' : 'Reverse'}
                    </button>
                  ) : (
                    <span className="data-table__muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
