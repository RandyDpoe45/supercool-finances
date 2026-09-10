import type { AccountDto } from '../../services/api/contracts/accounts';
import { AccountCard } from '../molecules/AccountCard';

/**
 * The accounts overview: a semantic list of account cards. Empty state is handled here so
 * the page only worries about loading/error. Order follows the server's `GET /api/accounts`
 * response (no client-side re-sorting).
 */
export function AccountsList({ accounts }: { accounts: AccountDto[] }) {
  if (accounts.length === 0) {
    return <p>No accounts.</p>;
  }
  return (
    <ul aria-label="accounts" className="accounts-list">
      {accounts.map((account) => (
        <AccountCard key={account.id} account={account} />
      ))}
    </ul>
  );
}
