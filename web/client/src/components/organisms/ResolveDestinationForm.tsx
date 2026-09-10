import { useId, useState, type FormEvent } from 'react';
import { FieldError } from '../atoms/FieldError';

/** Mirrors the service's `accountNumber` schema (a 10-digit numeric string) so obviously-malformed
 * input is caught before a request; the server re-validates regardless. */
const ACCOUNT_NUMBER = /^\d{10}$/;

/**
 * Step 1 of the transfer — confirmation of payee. The payer enters the destination's 10-digit
 * account number; on submit the page resolves it to a masked holder name + a confirmation token.
 * This organism owns only its input + client-side shape check; the page owns the request and its
 * result.
 */
export function ResolveDestinationForm({
  onResolve,
  isResolving,
  serverError,
}: {
  onResolve: (accountNumber: string) => void;
  isResolving: boolean;
  serverError?: string;
}) {
  const inputId = useId();
  const [accountNumber, setAccountNumber] = useState('');
  const [touched, setTouched] = useState(false);

  const trimmed = accountNumber.trim();
  const valid = ACCOUNT_NUMBER.test(trimmed);
  const showFormatError = touched && !valid;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!valid || isResolving) {
      return;
    }
    onResolve(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="transfer-form">
      <label htmlFor={inputId}>Destination account number</label>
      <input
        id={inputId}
        inputMode="numeric"
        autoComplete="off"
        placeholder="10 digits"
        value={accountNumber}
        onChange={(event) => setAccountNumber(event.target.value)}
        onBlur={() => setTouched(true)}
        aria-invalid={showFormatError}
      />
      <FieldError
        message={showFormatError ? 'Enter a 10-digit account number.' : (serverError ?? undefined)}
      />
      <div className="form-actions">
        <button type="submit" disabled={!valid || isResolving}>
          {isResolving ? 'Looking up…' : 'Look up account'}
        </button>
      </div>
    </form>
  );
}
