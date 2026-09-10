import type { ResolvedPayee } from '../../lib/transferFlow';

/**
 * Confirmation of payee: shows the destination account number, its currency, and the service's
 * MASKED holder name, and asks the payer to explicitly confirm this is the right person before any
 * amount is entered. The masked name is the only identity the service discloses (PII stays server
 * side); the payer sanity-checks it against who they mean to pay.
 */
export function PayeeConfirmation({
  payee,
  onConfirm,
  onReject,
  disabled = false,
}: {
  payee: ResolvedPayee;
  onConfirm: () => void;
  onReject: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="payee-confirm">
      <p>Please confirm you are paying:</p>
      <dl className="payee-confirm__details">
        <div>
          <dt>Name</dt>
          <dd>{payee.maskedName}</dd>
        </div>
        <div>
          <dt>Account number</dt>
          <dd>{payee.accountNumber}</dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>{payee.currency}</dd>
        </div>
      </dl>
      <div className="form-actions">
        <button type="button" onClick={onConfirm} disabled={disabled}>
          Yes, this is correct
        </button>
        <button type="button" className="button--secondary" onClick={onReject} disabled={disabled}>
          No, use a different account
        </button>
      </div>
    </div>
  );
}
