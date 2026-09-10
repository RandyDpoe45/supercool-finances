import { describeApiError } from '../../lib/apiError';
import { useGetAccountsQuery } from '../../services/api/accountsApi';
import { AccountsList } from '../organisms/AccountsList';

/**
 * Accounts overview (home route). Owns the loading/error states; the list organism owns the
 * empty state and rendering. Selecting an account navigates to its statement.
 */
export function AccountsPage() {
  const { data: accounts, isLoading, isError, error } = useGetAccountsQuery();

  return (
    <section>
      <h1>Your accounts</h1>
      {isLoading && <p>Loading accounts…</p>}
      {isError && <p role="alert">Failed to load accounts ({describeApiError(error)}).</p>}
      {!isLoading && !isError && <AccountsList accounts={accounts ?? []} />}
    </section>
  );
}
