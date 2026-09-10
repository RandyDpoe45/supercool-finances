import { useId, useMemo, useState, type FormEvent } from 'react';
import { formatMoney, safeParseAmountToMinor } from '../../lib/money';
import type { ResolvedPayee } from '../../lib/transferFlow';
import type { AccountDto } from '../../services/api/contracts/accounts';
import { FieldError } from '../atoms/FieldError';
import { CaptchaStub } from '../molecules/CaptchaStub';

/**
 * Step 2 of the transfer — amount + source, gated by the demo captcha. The payer picks one of their
 * OWN accounts (only those whose currency matches the resolved destination, and never the
 * destination itself) and enters a human MAJOR-unit amount, which is converted to a minor-unit
 * integer string EXACTLY (float-free) before it can be submitted. The captcha must be solved before
 * initiate is enabled. When the service soft-blocks an identical recent payment as a suspected
 * duplicate, the submit becomes an explicit "Send anyway" (re-submitting with `confirmDuplicate`
 * and the SAME idempotency key, which the page holds).
 */
export function TransferAmountForm({
  payee,
  accounts,
  onInitiate,
  isInitiating,
  serverError,
  suspectedDuplicate,
}: {
  payee: ResolvedPayee;
  accounts: AccountDto[];
  onInitiate: (args: {
    sourceAccountId: string;
    amount: string;
    confirmDuplicate: boolean;
  }) => void;
  isInitiating: boolean;
  serverError?: string;
  suspectedDuplicate: boolean;
}) {
  const sourceId = useId();
  const amountId = useId();

  // Eligible sources: the caller's own CUSTOMER accounts in the destination's currency, excluding
  // the destination account number itself (the service rejects source === destination).
  const eligible = useMemo(
    () =>
      accounts.filter(
        (account) =>
          account.kind === 'customer' &&
          account.currency === payee.currency &&
          account.accountNumber !== payee.accountNumber,
      ),
    [accounts, payee.currency, payee.accountNumber],
  );

  const [sourceAccountId, setSourceAccountId] = useState(() => eligible[0]?.id ?? '');
  const [amountInput, setAmountInput] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [captchaSolved, setCaptchaSolved] = useState(false);

  const parsed = safeParseAmountToMinor(amountInput, payee.currency);
  const sourceSelected = eligible.some((account) => account.id === sourceAccountId);
  const canSubmit = parsed.ok && sourceSelected && captchaSolved && !isInitiating;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setAmountTouched(true);
    if (!canSubmit || !parsed.ok) {
      return;
    }
    onInitiate({ sourceAccountId, amount: parsed.minor, confirmDuplicate: suspectedDuplicate });
  }

  if (eligible.length === 0) {
    return (
      <p role="alert">You have no {payee.currency} account that can send to this destination.</p>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="transfer-form">
      <label htmlFor={sourceId}>From account</label>
      <select
        id={sourceId}
        value={sourceAccountId}
        onChange={(event) => setSourceAccountId(event.target.value)}
      >
        {eligible.map((account) => (
          <option key={account.id} value={account.id}>
            {(account.accountNumber ?? account.id) +
              ` — ${formatMoney(account.available, account.currency)} available`}
          </option>
        ))}
      </select>

      <label htmlFor={amountId}>Amount ({payee.currency})</label>
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
