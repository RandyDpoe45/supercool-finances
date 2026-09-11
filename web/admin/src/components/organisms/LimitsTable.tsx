import type { LimitsDto } from '../../services/api/contracts/limits';
import { Money } from '../atoms/Money';
import { Timestamp } from '../atoms/Timestamp';

/** One cap cell: the float-free `Money` rendering, or an em-dash when the cap is `null` (uncapped). */
function Cap({ minorUnits, currency }: { minorUnits: string | null; currency: string }) {
  if (minorUnits === null) {
    return <span className="data-table__muted">uncapped</span>;
  }
  return <Money amount={minorUnits} currency={currency} />;
}

/**
 * Current limits as a table: the global baseline plus any per-customer overrides, each showing its
 * scope, owner (— for global), currency, the three caps (via the float-free `Money` atom, "uncapped"
 * when null), and when it was last updated. Order follows the server response. Empty state is owned
 * here; the page owns the read query's loading/error.
 */
export function LimitsTable({ limits }: { limits: LimitsDto[] }) {
  if (limits.length === 0) {
    return <p>No limits configured.</p>;
  }
  return (
    <table aria-label="limits" className="data-table">
      <thead>
        <tr>
          <th scope="col">Scope</th>
          <th scope="col">Owner</th>
          <th scope="col">Currency</th>
          <th scope="col">Per transaction</th>
          <th scope="col">Daily</th>
          <th scope="col">Monthly</th>
          <th scope="col">Updated (Mexico City)</th>
        </tr>
      </thead>
      <tbody>
        {limits.map((row) => (
          <tr key={row.id} data-limits-id={row.id}>
            <td>{row.scope}</td>
            <td className="data-table__ref">{row.ownerId ?? '—'}</td>
            <td>{row.currency}</td>
            <td className="data-table__amount">
              <Cap minorUnits={row.perTransactionMax} currency={row.currency} />
            </td>
            <td className="data-table__amount">
              <Cap minorUnits={row.dailyMax} currency={row.currency} />
            </td>
            <td className="data-table__amount">
              <Cap minorUnits={row.monthlyMax} currency={row.currency} />
            </td>
            <td>
              <Timestamp iso={row.updatedAt} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
