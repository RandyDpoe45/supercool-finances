import { useId, useState, type FormEvent } from 'react';
import { FieldError } from '../atoms/FieldError';

/** Mirrors the service's label rule so obviously-malformed input is caught before a request; the
 * server re-validates regardless. The label is trimmed then bounded 1..50 characters. */
const LABEL_MIN = 1;
const LABEL_MAX = 50;

/**
 * Open a new account — the customer supplies only a name (`label`). The new account is money-safe by
 * construction on the server (empty balances, `active`/`customer`/`MXN`, a fresh account number), so
 * this form owns nothing money-related; it just hands the trimmed label up and the page owns the
 * request. Create stays disabled until the label is shape-valid.
 */
export function CreateAccountForm({
  onCreate,
  isCreating,
  serverError,
}: {
  onCreate: (args: { label: string }) => void;
  isCreating: boolean;
  serverError?: string;
}) {
  const labelId = useId();

  const [label, setLabel] = useState('');
  const [touched, setTouched] = useState(false);

  const trimmed = label.trim();
  const labelValid = trimmed.length >= LABEL_MIN && trimmed.length <= LABEL_MAX;
  const canSubmit = labelValid && !isCreating;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!canSubmit) {
      return;
    }
    onCreate({ label: trimmed });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="transfer-form">
      <label htmlFor={labelId}>Account name</label>
      <input
        id={labelId}
        autoComplete="off"
        placeholder="e.g. Savings"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        onBlur={() => setTouched(true)}
        aria-invalid={touched && !labelValid}
      />
      <FieldError
        message={touched && !labelValid ? 'Enter a name (1–50 characters).' : undefined}
      />

      <FieldError message={serverError} />

      <div className="form-actions">
        <button type="submit" disabled={!canSubmit}>
          {isCreating ? 'Creating…' : 'Create account'}
        </button>
      </div>
    </form>
  );
}
