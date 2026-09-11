import type { AccountSummaryDto } from '../../services/api/contracts/analytics';
import { Money } from '../atoms/Money';
import { Timestamp } from '../atoms/Timestamp';

/**
 * The per-account activity + latest-known-balance report as a read-only table: the account id
 * (with its `accountKind` and, for a system account, its `systemKey` shown as muted context), the
 * owning customer (`ownerId`, an em-dash on a system account), currency, the last balance, the
 * transaction count, and the total debited / credited. The three money fields render via the
 * float-free `Money` atom (minor-unit STRING — never parsed to a float); `txnCount` is a safe
 * integer. `lastActivityAt` is an ISO-8601 UTC instant, converted to Mexico City time via the
 * `Timestamp` atom (contrast the daily-aggregate `date`, which is a verbatim UTC day label). Owns
 * the empty state; the page owns the query's loading/error and the filter/paging.
 */
export function AccountSummariesTable({ summaries }: { summaries: AccountSummaryDto[] }) {
  if (summaries.length === 0) {
    return <p>No account summaries.</p>;
  }
  return (
    <table aria-label="account summaries" className="data-table">
      <thead>
        <tr>
          <th scope="col">Account</th>
          <th scope="col">Owner</th>
          <th scope="col">Currency</th>
          <th scope="col">Last balance</th>
          <th scope="col">Txns</th>
          <th scope="col">Debited</th>
          <th scope="col">Credited</th>
          <th scope="col">Last activity (Mexico City)</th>
        </tr>
      </thead>
      <tbody>
        {summaries.map((row) => (
          <tr key={row.accountId} data-account-id={row.accountId}>
            <td className="data-table__ref">
              {row.accountId}
              <span className="data-table__muted">
                {' '}
                ({row.accountKind}
                {row.systemKey === null ? '' : ` · ${row.systemKey}`})
              </span>
            </td>
            <td className="data-table__ref">{row.ownerId ?? '—'}</td>
            <td>{row.currency}</td>
            <td className="data-table__amount">
              <Money amount={row.lastBalanceAfter} currency={row.currency} />
            </td>
            <td className="data-table__amount">{row.txnCount}</td>
            <td className="data-table__amount">
              <Money amount={row.totalDebited} currency={row.currency} />
            </td>
            <td className="data-table__amount">
              <Money amount={row.totalCredited} currency={row.currency} />
            </td>
            <td>
              <Timestamp iso={row.lastActivityAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
