import type { DailyAggregateDto } from '../../services/api/contracts/analytics';
import { Money } from '../atoms/Money';

/**
 * The per-day × currency × type volume report as a read-only table: the UTC day bucket, currency,
 * transaction type (a small `<code>` tag), the row `count`, and the `totalAmount` (float-free
 * `Money` with the ISO code, minor-unit STRING — never parsed to a float). The **Date** column is
 * the `date` LABEL rendered VERBATIM (`YYYY-MM-DD`, a UTC day bucket) — it is deliberately NOT
 * timezone-converted, unlike an instant. Owns the empty state; the page owns the query's
 * loading/error and the filter/paging.
 */
export function DailyAggregatesTable({ aggregates }: { aggregates: DailyAggregateDto[] }) {
  if (aggregates.length === 0) {
    return <p>No aggregates.</p>;
  }
  return (
    <table aria-label="daily aggregates" className="data-table">
      <thead>
        <tr>
          <th scope="col">Date (UTC day)</th>
          <th scope="col">Currency</th>
          <th scope="col">Type</th>
          <th scope="col">Count</th>
          <th scope="col">Total</th>
        </tr>
      </thead>
      <tbody>
        {aggregates.map((row) => (
          <tr key={`${row.date}:${row.currency}:${row.type}`}>
            <td className="data-table__ref">{row.date}</td>
            <td>{row.currency}</td>
            <td>
              <code className="type-tag">{row.type}</code>
            </td>
            <td className="data-table__amount">{row.count}</td>
            <td className="data-table__amount">
              <Money amount={row.totalAmount} currency={row.currency} showCode />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
