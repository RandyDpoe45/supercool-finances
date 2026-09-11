import { useId, useState, type FormEvent } from 'react';
import { formatAmount, isUnsignedMinorUnits } from '../../lib/money';
import type { LimitsScope, UpsertLimitsBody } from '../../services/api/contracts/limits';
import { FieldError } from '../atoms/FieldError';

/** Currency is a 3-letter ISO code (the system is MXN-only today; the server re-validates). */
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

/** One editable cap field: an UNSIGNED minor-unit integer string, or empty for uncapped (`null`). */
interface CapFieldProps {
  id: string;
  label: string;
  currency: string;
  value: string;
  touched: boolean;
  onChange: (next: string) => void;
  onBlur: () => void;
}

/** Validate a raw cap input: empty is allowed (uncapped); otherwise it must be a canonical unsigned
 * minor-unit integer within int64 — checked float-free by `isUnsignedMinorUnits`. */
function capValid(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed === '' || isUnsignedMinorUnits(trimmed);
}

/** A single cap input with a live float-free major-unit preview (e.g. `150000` → `= 1,500.00`). */
function CapField({ id, label, currency, value, touched, onChange, onBlur }: CapFieldProps) {
  const trimmed = value.trim();
  const valid = capValid(value);
  const previewCurrency = CURRENCY_PATTERN.test(currency) ? currency.toUpperCase() : 'MXN';
  const preview = valid && trimmed !== '' ? formatAmount(trimmed, previewCurrency) : null;
  return (
    <>
      <label htmlFor={id}>{label} (minor units)</label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        placeholder="empty = uncapped"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        aria-invalid={touched && !valid}
      />
      {preview !== null && (
        <p className="cap-preview">
          = {preview} {previewCurrency}
        </p>
      )}
      <FieldError
        message={
          touched && !valid ? 'Enter whole minor units (digits only) or leave empty.' : undefined
        }
      />
    </>
  );
}

/**
 * Edit form for `PUT /admin/limits` (upsert a limits row). Enforces the scope⇒ownerId rule BEFORE
 * submit: `global` sends `ownerId: null` (the field is hidden), `customer` REQUIRES a non-empty
 * `ownerId`. The three caps are entered as UNSIGNED minor-unit integer strings (empty = uncapped /
 * `null`); nothing is ever parsed to a float. The page owns the mutation and passes `onSubmit`,
 * `isSubmitting`, and the server's error message (e.g. `INVALID_LIMITS`) which renders via
 * `FieldError`.
 */
export function LimitsForm({
  onSubmit,
  isSubmitting,
  serverError,
}: {
  onSubmit: (body: UpsertLimitsBody) => void;
  isSubmitting: boolean;
  serverError?: string;
}) {
  const scopeId = useId();
  const ownerId = useId();
  const currencyId = useId();
  const perTxId = useId();
  const dailyId = useId();
  const monthlyId = useId();

  const [scope, setScope] = useState<LimitsScope>('global');
  const [owner, setOwner] = useState('');
  const [currency, setCurrency] = useState('MXN');
  const [perTransactionMax, setPerTransactionMax] = useState('');
  const [dailyMax, setDailyMax] = useState('');
  const [monthlyMax, setMonthlyMax] = useState('');

  const [ownerTouched, setOwnerTouched] = useState(false);
  const [currencyTouched, setCurrencyTouched] = useState(false);
  const [perTxTouched, setPerTxTouched] = useState(false);
  const [dailyTouched, setDailyTouched] = useState(false);
  const [monthlyTouched, setMonthlyTouched] = useState(false);

  const trimmedOwner = owner.trim();
  const ownerValid = scope === 'global' || trimmedOwner.length > 0;
  const currencyValid = CURRENCY_PATTERN.test(currency.trim());
  const capsValid = capValid(perTransactionMax) && capValid(dailyMax) && capValid(monthlyMax);
  const canSubmit = ownerValid && currencyValid && capsValid && !isSubmitting;

  /** Empty input → `null` (uncapped); otherwise the trimmed minor-unit string, verbatim. */
  function capToBody(raw: string): string | null {
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setOwnerTouched(true);
    setCurrencyTouched(true);
    setPerTxTouched(true);
    setDailyTouched(true);
    setMonthlyTouched(true);
    if (!canSubmit) {
      return;
    }
    const body: UpsertLimitsBody = {
      scope,
      // The scope⇒ownerId rule, enforced at the edge: global carries an explicit null; customer
      // carries the entered owner. The server re-checks and 400s (INVALID_LIMITS) on a violation.
      ownerId: scope === 'customer' ? trimmedOwner : null,
      currency: currency.trim().toUpperCase(),
      perTransactionMax: capToBody(perTransactionMax),
      dailyMax: capToBody(dailyMax),
      monthlyMax: capToBody(monthlyMax),
    };
    onSubmit(body);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="limits-form">
      <label htmlFor={scopeId}>Scope</label>
      <select
        id={scopeId}
        value={scope}
        onChange={(event) => setScope(event.target.value as LimitsScope)}
      >
        <option value="global">Global (baseline)</option>
        <option value="customer">Customer (override)</option>
      </select>

      {scope === 'customer' && (
        <>
          <label htmlFor={ownerId}>Owner ID</label>
          <input
            id={ownerId}
            autoComplete="off"
            placeholder="customer owner id"
            value={owner}
            onChange={(event) => setOwner(event.target.value)}
            onBlur={() => setOwnerTouched(true)}
            aria-invalid={ownerTouched && !ownerValid}
          />
          <FieldError
            message={
              ownerTouched && !ownerValid
                ? 'Owner ID is required for a customer override.'
                : undefined
            }
          />
        </>
      )}

      <label htmlFor={currencyId}>Currency</label>
      <input
        id={currencyId}
        autoComplete="off"
        maxLength={3}
        placeholder="MXN"
        value={currency}
        onChange={(event) => setCurrency(event.target.value)}
        onBlur={() => setCurrencyTouched(true)}
        aria-invalid={currencyTouched && !currencyValid}
      />
      <FieldError
        message={currencyTouched && !currencyValid ? 'Enter a 3-letter currency code.' : undefined}
      />

      <CapField
        id={perTxId}
        label="Per-transaction max"
        currency={currency}
        value={perTransactionMax}
        touched={perTxTouched}
        onChange={setPerTransactionMax}
        onBlur={() => setPerTxTouched(true)}
      />
      <CapField
        id={dailyId}
        label="Daily max"
        currency={currency}
        value={dailyMax}
        touched={dailyTouched}
        onChange={setDailyMax}
        onBlur={() => setDailyTouched(true)}
      />
      <CapField
        id={monthlyId}
        label="Monthly max"
        currency={currency}
        value={monthlyMax}
        touched={monthlyTouched}
        onChange={setMonthlyMax}
        onBlur={() => setMonthlyTouched(true)}
      />

      <FieldError message={serverError} />

      <div className="form-actions">
        <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
          {isSubmitting ? 'Saving…' : 'Save limits'}
        </button>
      </div>
    </form>
  );
}
