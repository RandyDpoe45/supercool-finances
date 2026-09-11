import { useState, type FormEvent } from 'react';
import { describeApiError } from '../../lib/apiError';
import {
  useFreezeAccountMutation,
  useGetAccountsQuery,
  useUnfreezeAccountMutation,
} from '../../services/api/accountsApi';
import { AccountsTable } from '../organisms/AccountsTable';

/**
 * Account management (route `/accounts`). Owns the accounts read query (loading / error) and the
 * freeze / unfreeze mutation hooks; the table owns the empty state, per-row actions, and rendering.
 * An optional owner-id filter narrows the list to one customer's accounts (server-side filter).
 * `pendingId` is the id of whichever freeze/unfreeze is currently in flight (from the mutation's
 * `originalArgs`), so only the acting row's button disables.
 */
export function AccountsPage() {
  const [ownerInput, setOwnerInput] = useState('');
  const [appliedOwner, setAppliedOwner] = useState('');

  const {
    data: accounts,
    isLoading,
    isError,
    error,
  } = useGetAccountsQuery(appliedOwner ? { ownerId: appliedOwner } : undefined);

  const [freeze, freezeState] = useFreezeAccountMutation();
  const [unfreeze, unfreezeState] = useUnfreezeAccountMutation();

  const pendingId = freezeState.isLoading
    ? freezeState.originalArgs
    : unfreezeState.isLoading
      ? unfreezeState.originalArgs
      : undefined;
  // Surface only the most-recently-triggered action's error, so a failed freeze's banner does not
  // linger after a later SUCCESSFUL unfreeze (each mutation hook retains its own last error).
  const actionError =
    (unfreezeState.startedTimeStamp ?? 0) > (freezeState.startedTimeStamp ?? 0)
      ? unfreezeState.error
      : freezeState.error;

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setAppliedOwner(ownerInput.trim());
  }

  function clearFilter() {
    setOwnerInput('');
    setAppliedOwner('');
  }

  return (
    <section>
      <h1>Account management</h1>
      <form onSubmit={applyFilter} className="filter-bar" role="search">
        <label htmlFor="owner-filter">Filter by owner ID</label>
        <input
          id="owner-filter"
          autoComplete="off"
          placeholder="all customers"
          value={ownerInput}
          onChange={(event) => setOwnerInput(event.target.value)}
        />
        <button type="submit" className="btn btn--secondary">
          Filter
        </button>
        {appliedOwner !== '' && (
          <button type="button" className="btn btn--secondary" onClick={clearFilter}>
            Clear
          </button>
        )}
      </form>

      {isLoading && <p>Loading…</p>}
      {isError && <p role="alert">Failed to load accounts ({describeApiError(error)}).</p>}
      {!isLoading && !isError && (
        <AccountsTable
          accounts={accounts ?? []}
          onFreeze={(id) => void freeze(id)}
          onUnfreeze={(id) => void unfreeze(id)}
          pendingId={pendingId}
          actionError={actionError}
        />
      )}
    </section>
  );
}
