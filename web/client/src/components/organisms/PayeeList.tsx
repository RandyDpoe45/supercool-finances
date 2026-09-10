import type { PayeeDto } from '../../services/api/contracts/payees';
import { PayeeCard } from '../molecules/PayeeCard';

/**
 * The enrolled-payee list: a semantic list of payee cards. Empty state is handled here so the page
 * only worries about loading/error. Order follows the server's `GET /api/payees` response.
 */
export function PayeeList({ payees }: { payees: PayeeDto[] }) {
  if (payees.length === 0) {
    return <p>No payees enrolled yet.</p>;
  }
  return (
    <ul aria-label="payees" className="accounts-list">
      {payees.map((payee) => (
        <PayeeCard key={payee.id} payee={payee} />
      ))}
    </ul>
  );
}
