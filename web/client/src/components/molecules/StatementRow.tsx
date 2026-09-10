import type { StatementEntryDto } from '../../services/api/contracts/accounts';
import { amountDirection } from '../../lib/money';
import { Money } from '../atoms/Money';
import { Timestamp } from '../atoms/Timestamp';

const DIRECTION_LABEL: Record<ReturnType<typeof amountDirection>, string> = {
  in: 'Credit',
  out: 'Debit',
  zero: '—',
};

/**
 * One statement leg as a table row: when it happened (Mexico City time), its direction
 * (derived from the sign of `delta`), the signed amount, the running balance after it, and
 * the transaction reference it belongs to.
 */
export function StatementRow({ entry }: { entry: StatementEntryDto }) {
  const direction = amountDirection(entry.delta);
  return (
    <tr>
      <td>
        <Timestamp iso={entry.createdAt} />
      </td>
      <td>
        <span className={`direction direction--${direction}`}>{DIRECTION_LABEL[direction]}</span>
      </td>
      <td className="statement__amount">
        <Money amount={entry.delta} currency={entry.currency} signed showCode />
      </td>
      <td className="statement__amount">
        <Money amount={entry.balanceAfter} currency={entry.currency} showCode />
      </td>
      <td className="statement__ref">{entry.transactionId}</td>
    </tr>
  );
}
