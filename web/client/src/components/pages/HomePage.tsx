import { useGetAccountsQuery } from '../../services/api/accountsApi';
import { AccountsList } from '../organisms/AccountsList';

/**
 * F1 smoke screen. Proves the full spine: PKCE access token -> RTK Query bearer ->
 * MSW `/api/accounts` stub -> render. Replaced by the real accounts UI in step F2.
 */
export function HomePage() {
  const { data: accounts, isLoading, isError, error } = useGetAccountsQuery();

  if (isLoading) {
    return <p>Loading accounts…</p>;
  }
  if (isError) {
    return <p role="alert">Failed to load accounts ({describeError(error)}).</p>;
  }
  return <AccountsList accounts={accounts ?? []} />;
}

function describeError(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    return `HTTP ${String((error as { status: unknown }).status)}`;
  }
  return 'unknown error';
}
