import { useId, useMemo, useState, type FormEvent } from 'react';
import { formatMoney, safeParseAmountToMinor } from '../../lib/money';
import type { AccountDto } from '../../services/api/contracts/accounts';
import type { PayeeDto } from '../../services/api/contracts/payees';
import { FieldError } from '../atoms/FieldError';
import { CaptchaStub } from '../molecules/CaptchaStub';

/**
 * The external-transfer compose step — pick a USABLE enrolled payee + one of the payer's own
 * accounts + an amount, gated by the demo captcha. Unlike the internal flow there is no
 * confirmation-of-payee step; the payee is chosen straight from the enrolled list (cooling-off is
 * the anti-fraud gate). Only payees the server hints are `usable` are selectable — but that is a
 * HINT, so the page still surfaces a `PAYEE_IN_COOLING_OFF` from the server cleanly.
 *
 * The transfer currency is the SELECTED SOURCE account's currency (a payee carries none), and the
 * human major-unit amount is converted to an exact minor-unit integer string (float-free) before
 * submit. Initiating PLACES A HOLD, so the payer is told the amount is reserved until they confirm.
 * A soft-blocked duplicate turns the submit into an explicit "Send anyway" (same idempotency key,
 * held by the page, plus `confirmDuplicate`).
 */
export function ExternalTransferForm({
  payees,
  accounts,
  initialPayeeId,
  onInitiate,
  isInitiating,
  serverError,
  suspectedDuplicate,
}: {
  payees: PayeeDto[];
  accounts: AccountDto[];
  initialPayeeId?: string;
  onInitiate: (args: {
    payeeId: string;
    sourceAccountId: string;
    amount: string;
    currency: string;
    confirmDuplicate: boolean;
  }) => void;
  isInitiating: boolean;
  serverError?: string;
  suspectedDuplicate: boolean;
}) {
  const payeeSelectId = useId();
  const sourceId = useId();
  const amountId = useId();

  // Only usable payees are eligible destinations (the server hint gates selection).
  const usablePayees = useMemo(() => payees.filter((payee) => payee.usable), [payees]);
  // Eligible sources: the payer's own CUSTOMER accounts.
  const eligibleSources = useMemo(
    () => accounts.filter((account) => account.kind === 'customer'),
    [accounts],
  );

  const [payeeId, setPayeeId] = useState(() => {
    if (initialPayeeId && usablePayees.some((payee) => payee.id === initialPayeeId)) {
      return initialPayeeId;
    }
    return usablePayees[0]?.id ?? '';
  });
  const [sourceAccountId, setSourceAccountId] = useState(() => eligibleSources[0]?.id ?? '');
  const [amountInput, setAmountInput] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [captchaSolved, setCaptchaSolved] = useState(false);

  const source = eligibleSources.find((account) => account.id === sourceAccountId);
  // The transfer currency is the source account's currency (a payee has none). Fall back to MXN only
  // to keep the parser defined before a source is chosen; submit is gated on a real source anyway.
  const currency = source?.currency ?? 'MXN';

  const parsed = safeParseAmountToMinor(amountInput, currency);
  const payeeSelected = usablePayees.some((payee) => payee.id === payeeId);
  const sourceSelected = eligibleSources.some((account) => account.id === sourceAccountId);
  const canSubmit = payeeSelected && sourceSelected && parsed.ok && captchaSolved && !isInitiating;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setAmountTouched(true);
    if (!canSubmit || !parsed.ok || !source) {
      return;
    }
    onInitiate({
      payeeId,
      sourceAccountId,
      amount: parsed.minor,
      currency: source.currency,
      confirmDuplicate: suspectedDuplicate,
    });
  }

  if (usablePayees.length === 0) {
    return (
      <p role="alert">
        You have no payees ready to receive money yet. Enroll one and wait for its cooling-off
        period to pass.
      </p>
    );
  }
  if (eligibleSources.length === 0) {
    return <p role="alert">You have no account that can send an external transfer.</p>;
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="transfer-form">
      <label htmlFor={payeeSelectId}>Pay</label>
      <select
        id={payeeSelectId}
        value={payeeId}
        onChange={(event) => setPayeeId(event.target.value)}
      >
        {usablePayees.map((payee) => (
          <option key={payee.id} value={payee.id}>
            {`${payee.displayName} — #${payee.destinationRef}`}
          </option>
        ))}
      </select>

      <label htmlFor={sourceId}>From account</label>
      <select
        id={sourceId}
        value={sourceAccountId}
        onChange={(event) => setSourceAccountId(event.target.value)}
      >
        {eligibleSources.map((account) => (
          <option key={account.id} value={account.id}>
            {(account.accountNumber ?? account.id) +
              ` — ${formatMoney(account.available, account.currency)} available`}
          </option>
        ))}
      </select>

      <label htmlFor={amountId}>Amount ({currency})</label>
      <input
        id={amountId}
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        value={amountInput}
        onChange={(event) => setAmountInput(event.target.value)}
        onBlur={() => setAmountTouched(true)}
        aria-invalid={amountTouched && !parsed.ok}
      />
      <FieldError message={amountTouched && !parsed.ok ? parsed.error.message : undefined} />

      <p className="transfer-confirm__hint">
        The amount is held on your account when you send, and released if you cancel.
      </p>

      <CaptchaStub onSolvedChange={setCaptchaSolved} />

      <FieldError message={serverError} />

      <div className="form-actions">
        <button type="submit" disabled={!canSubmit}>
          {isInitiating ? 'Sending…' : suspectedDuplicate ? 'Send anyway' : 'Send'}
        </button>
      </div>
    </form>
  );
}
