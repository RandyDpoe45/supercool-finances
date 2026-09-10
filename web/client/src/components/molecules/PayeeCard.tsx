import { Link } from 'react-router-dom';
import type { PayeeDto } from '../../services/api/contracts/payees';
import { CoolingOffStatus } from '../atoms/CoolingOffStatus';

/**
 * One enrolled payee: its display label, the external account number the owner supplied
 * (`destinationRef` — the owner's own datum, shown unmasked to them), and its cooling-off status. A
 * "Send money" action is offered ONLY while the server hints the payee is `usable`; a still-cooling
 * payee shows when it becomes usable instead. `usable` is a HINT — the server remains authoritative,
 * so an attempt against a stale-usable payee still fails cleanly on the transfer page.
 */
export function PayeeCard({ payee }: { payee: PayeeDto }) {
  return (
    <li className="account-card payee-card">
      <div className="account-card__header">
        <span className="account-card__id">{payee.displayName}</span>
        <span className="account-card__kind">#{payee.destinationRef}</span>
      </div>
      <div className="payee-card__status">
        <CoolingOffStatus usable={payee.usable} coolingOffUntil={payee.coolingOffUntil} />
      </div>
      {payee.usable && (
        <div className="form-actions">
          <Link to={`/transfers/external?payeeId=${encodeURIComponent(payee.id)}`}>Send money</Link>
        </div>
      )}
    </li>
  );
}
