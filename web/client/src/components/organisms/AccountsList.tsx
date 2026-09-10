import type { AccountDto } from '../../services/api/contracts/accounts';

/**
 * Bare, unstyled account list — an F1 smoke view only. It renders raw contract
 * fields (money as their canonical minor-unit strings, no formatting) purely to
 * prove the data pipe end to end. The real, formatted accounts UI lands in step F2.
 */
export function AccountsList({ accounts }: { accounts: AccountDto[] }) {
  if (accounts.length === 0) {
    return <p>No accounts.</p>;
  }
  return (
    <ul aria-label="accounts">
      {accounts.map((account) => (
        <li key={account.id}>
          {account.accountNumber ?? account.id} — {account.available} {account.currency} (
          {account.status})
        </li>
      ))}
    </ul>
  );
}
