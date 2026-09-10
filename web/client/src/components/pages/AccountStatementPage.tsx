import { Link, useParams } from 'react-router-dom';
import { describeApiError } from '../../lib/apiError';
import { useGetAccountStatementQuery } from '../../services/api/accountsApi';
import { StatementTable } from '../organisms/StatementTable';

/**
 * One account's statement/history. The account id comes from the route; the query is skipped
 * until it is present. Owns loading/error; the table organism owns the empty state. A 404
 * (missing / non-owned / system account, indistinguishable by design) surfaces as a plain
 * "not found" error rather than leaking whether the account exists.
 */
export function AccountStatementPage() {
  const { id } = useParams<{ id: string }>();
  const accountId = id ?? '';
  const { data, isLoading, isError, error } = useGetAccountStatementQuery(accountId, {
    skip: accountId === '',
  });

  return (
    <section>
      <p>
        <Link to="/">← Back to accounts</Link>
      </p>
      <h1>Statement</h1>
      {isLoading && <p>Loading statement…</p>}
      {isError && <p role="alert">Failed to load statement ({describeApiError(error)}).</p>}
      {!isLoading && !isError && data && <StatementTable entries={data.entries} />}
    </section>
  );
}
