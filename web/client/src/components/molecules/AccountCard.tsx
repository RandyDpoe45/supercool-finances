import { Link } from 'react-router-dom';
import type { AccountDto } from '../../services/api/contracts/accounts';
import { CopyButton } from '../atoms/CopyButton';
import { Money } from '../atoms/Money';
import { StatusBadge } from '../atoms/StatusBadge';

/**
 * One account in the overview: its identifier (linking to the statement), currency, kind
 * and status, plus the three money fields (balance / held / available). Rendered as an
 * `<li>` so the surrounding list stays a semantic list.
 */
export function AccountCard({ account }: { account: AccountDto }) {
  return (
    <li className="account-card">
      <div className="account-card__header">
        <Link className="account-card__id" to={`/accounts/${account.id}/transactions`}>
          {account.accountNumber ?? account.id}
        </Link>
        {account.label ? <span className="account-card__label">{account.label}</span> : null}
        <span className="account-card__currency">{account.currency}</span>
        <span className="account-card__kind">{account.kind}</span>
        <StatusBadge status={account.status} />
        <CopyButton value={account.accountNumber ?? account.id} label="Copy account number" />
      </div>
      <dl className="account-card__money">
        <div>
          <dt>Balance</dt>
          <dd>
            <Money amount={account.balance} currency={account.currency} />
          </dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>
            <Money amount={account.held} currency={account.currency} />
          </dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd>
            <Money amount={account.available} currency={account.currency} />
          </dd>
        </div>
      </dl>
    </li>
  );
}
