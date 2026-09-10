import type { StatementEntryDto } from '../../services/api/contracts/accounts';
import { StatementRow } from '../molecules/StatementRow';

/**
 * An account's statement as a table (newest-first, as delivered by the server). Empty state
 * is handled here; loading/error stay with the page.
 */
export function StatementTable({ entries }: { entries: StatementEntryDto[] }) {
  if (entries.length === 0) {
    return <p>No transactions yet.</p>;
  }
  return (
    <table aria-label="statement" className="statement">
      <thead>
        <tr>
          <th scope="col">Date (Mexico City)</th>
          <th scope="col">Type</th>
          <th scope="col">Amount</th>
          <th scope="col">Balance after</th>
          <th scope="col">Reference</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <StatementRow key={entry.id} entry={entry} />
        ))}
      </tbody>
    </table>
  );
}
