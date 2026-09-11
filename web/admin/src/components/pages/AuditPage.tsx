import { useState, type FormEvent } from 'react';
import { describeApiError } from '../../lib/apiError';
import { useGetAuditQuery } from '../../services/api/auditApi';
import { AUDIT_ACTIONS } from '../../services/api/contracts/audit';
import { AuditTable } from '../organisms/AuditTable';

/** Server default page size; the audit read is clamped to `[1, 200]` server-side, so a fixed 50 is a
 * safe page window. */
const PAGE_SIZE = 50;

/**
 * Audit view (route `/audit`). A read-only window over the admin `GET /admin/audit` log: an **action**
 * select (the fixed producer set) + an **actor id** text filter (Apply / Clear), offset pagination
 * (Prev / Next), and the `AuditTable` for the current page. Filters and paging feed the query; the
 * page owns loading (`Loading…`) / error (`role="alert"`) states, the table owns the empty state and
 * per-row rendering.
 *
 * **Pagination.** `offset = page * PAGE_SIZE`. **Prev** is disabled on the first page (`offset 0`);
 * **Next** is disabled when the current page returned fewer than a full `PAGE_SIZE` of rows (the last
 * page). Changing (Apply / Clear) a filter resets to page 0 so paging always starts from the newest.
 */
export function AuditPage() {
  const [actionInput, setActionInput] = useState('');
  const [actorInput, setActorInput] = useState('');
  const [appliedAction, setAppliedAction] = useState('');
  const [appliedActor, setAppliedActor] = useState('');
  const [page, setPage] = useState(0);

  const offset = page * PAGE_SIZE;
  const {
    data: entries,
    isLoading,
    isError,
    error,
  } = useGetAuditQuery({
    action: appliedAction || undefined,
    actorId: appliedActor || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setAppliedAction(actionInput);
    setAppliedActor(actorInput.trim());
    setPage(0);
  }

  function clearFilter() {
    setActionInput('');
    setActorInput('');
    setAppliedAction('');
    setAppliedActor('');
    setPage(0);
  }

  const rows = entries ?? [];
  const isFilterActive = appliedAction !== '' || appliedActor !== '';
  // The last page is the one that returned fewer than a full window of rows.
  const isLastPage = rows.length < PAGE_SIZE;

  return (
    <section>
      <h1>Audit log</h1>
      <form onSubmit={applyFilter} className="filter-bar" role="search">
        <label htmlFor="audit-action-filter">Action</label>
        <select
          id="audit-action-filter"
          value={actionInput}
          onChange={(event) => setActionInput(event.target.value)}
        >
          <option value="">All actions</option>
          {AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </select>
        <label htmlFor="audit-actor-filter">Actor ID</label>
        <input
          id="audit-actor-filter"
          autoComplete="off"
          placeholder="all actors"
          value={actorInput}
          onChange={(event) => setActorInput(event.target.value)}
        />
        <button type="submit" className="btn btn--secondary">
          Apply
        </button>
        {isFilterActive && (
          <button type="button" className="btn btn--secondary" onClick={clearFilter}>
            Clear
          </button>
        )}
      </form>

      {isLoading && <p>Loading…</p>}
      {isError && <p role="alert">Failed to load audit log ({describeApiError(error)}).</p>}
      {!isLoading && !isError && (
        <>
          <AuditTable entries={rows} />
          <nav className="pagination" aria-label="Audit pages">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={page === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              Previous
            </button>
            <span className="pagination__status">Page {page + 1}</span>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={isLastPage}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
