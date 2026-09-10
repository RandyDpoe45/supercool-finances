import { amountDirection, formatAmount, formatMoney } from '../../lib/money';

/**
 * Renders a minor-unit amount string as human money. Delegates ALL number handling to the
 * float-free helpers in `lib/money` — this atom never parses the amount itself.
 * `showCode` appends the ISO currency code; `signed` prepends `+` for a positive amount
 * (statement credits), so a signed row reads `+1,500.00` / `-6,000.00`.
 */
export function Money({
  amount,
  currency,
  showCode = false,
  signed = false,
  className,
}: {
  amount: string;
  currency: string;
  showCode?: boolean;
  signed?: boolean;
  className?: string;
}) {
  const body = showCode ? formatMoney(amount, currency) : formatAmount(amount, currency);
  const text = signed && amountDirection(amount) === 'in' ? `+${body}` : body;
  return <span className={className}>{text}</span>;
}
