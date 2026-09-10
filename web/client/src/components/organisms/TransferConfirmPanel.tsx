import { useId, useState, type FormEvent } from 'react';
import type { PendingTransferView } from '../../lib/transferFlow';
import { FieldError } from '../atoms/FieldError';
import { PendingTransferSummary } from '../molecules/PendingTransferSummary';

/** The one-time code is a numeric string (matches the service's confirm schema). */
const CODE = /^\d+$/;

/**
 * Step 3 of the transfer — OTP confirmation. Shows what is about to be authorized (amount, masked
 * destination, expiry) and takes the one-time code the payer obtained OUT OF BAND from the OTP app.
 * The client-app NEVER mints or reveals the code — it only submits it to confirm (which moves the
 * money) or cancels the pending transfer.
 */
export function TransferConfirmPanel({
  transfer,
  onConfirm,
  onCancel,
  isConfirming,
  isCancelling,
  serverError,
}: {
  transfer: PendingTransferView;
  onConfirm: (code: string) => void;
  onCancel: () => void;
  isConfirming: boolean;
  isCancelling: boolean;
  serverError?: string;
}) {
  const codeId = useId();
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);

  const trimmed = code.trim();
  const valid = CODE.test(trimmed);
  const busy = isConfirming || isCancelling;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!valid || busy) {
      return;
    }
    onConfirm(trimmed);
  }

  return (
    <div className="transfer-confirm">
      <PendingTransferSummary transfer={transfer} />
      <p className="transfer-confirm__hint">
        Enter the one-time code from your OTP app to authorize this transfer.
      </p>
      <form onSubmit={handleSubmit} noValidate className="transfer-form">
        <label htmlFor={codeId}>One-time code</label>
        <input
          id={codeId}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={touched && !valid}
        />
        <FieldError
          message={touched && !valid ? 'Enter the numeric one-time code.' : serverError}
        />
        <div className="form-actions">
          <button type="submit" disabled={!valid || busy}>
            {isConfirming ? 'Confirming…' : 'Confirm transfer'}
          </button>
          <button type="button" className="button--secondary" onClick={onCancel} disabled={busy}>
            {isCancelling ? 'Cancelling…' : 'Cancel transfer'}
          </button>
        </div>
      </form>
    </div>
  );
}
