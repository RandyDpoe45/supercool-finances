import { useState, type FormEvent } from 'react';
import { describeApiError } from '../../lib/apiError';
import {
  useGetAccountSummariesQuery,
  useGetDailyAggregatesQuery,
} from '../../services/api/analyticsApi';
import { AccountSummariesTable } from '../organisms/AccountSummariesTable';
import { DailyAggregatesTable } from '../organisms/DailyAggregatesTable';

/** Server default page size; both analytics reads are clamped to `[1, 200]` server-side, so a fixed
 * 50 is a safe page window (matches `AuditPage`). */
const PAGE_SIZE = 50;

/** The daily-aggregate `type` values, mirroring the server's `.strict()` enum. */
const AGGREGATE_TYPES = ['internal', 'external_outbound', 'external_inbound'] as const;

/**
 * Analytics dashboard (route `/analytics`). Wires the analytics server (spec 05) over its own
 * `/analytics/admin` gateway namespace (a SECOND RTK Query slice, `analyticsApi`). Two independent
 * report SECTIONS — **Daily aggregates** and **Account summaries** — each self-contained like
 * `AuditPage`: a filter bar (Apply / Clear), offset pagination (Prev / Next), page-owned
 * loading/error (`role="alert"`), and the section's read-only table. The two sections keep their
 * filter + paging state independent.
 */
export function AnalyticsPage() {
  return (
    <section>
      <h1>Analytics</h1>
      <DailyAggregatesSection />
      <AccountSummariesSection />
    </section>
  );
}

/**
 * Daily aggregates section: filter by currency / type / from / to (`from`/`to` are `YYYY-MM-DD`
 * day bounds from `<input type="date">`), offset paging (limit 50). Changing a filter resets to
 * page 0 so paging always starts from the first page.
 */
function DailyAggregatesSection() {
  const [currencyInput, setCurrencyInput] = useState('');
  const [typeInput, setTypeInput] = useState('');
  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [appliedCurrency, setAppliedCurrency] = useState('');
  const [appliedType, setAppliedType] = useState('');
  const [appliedFrom, setAppliedFrom] = useState('');
  const [appliedTo, setAppliedTo] = useState('');
  const [page, setPage] = useState(0);

  const offset = page * PAGE_SIZE;
  const {
    data: aggregates,
    isLoading,
    isError,
    error,
  } = useGetDailyAggregatesQuery({
    currency: appliedCurrency || undefined,
    type: appliedType || undefined,
    from: appliedFrom || undefined,
    to: appliedTo || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setAppliedCurrency(currencyInput.trim());
    setAppliedType(typeInput);
    setAppliedFrom(fromInput);
    setAppliedTo(toInput);
    setPage(0);
  }

  function clearFilter() {
    setCurrencyInput('');
    setTypeInput('');
    setFromInput('');
    setToInput('');
    setAppliedCurrency('');
    setAppliedType('');
    setAppliedFrom('');
    setAppliedTo('');
    setPage(0);
  }

  const rows = aggregates ?? [];
  const isFilterActive =
    appliedCurrency !== '' || appliedType !== '' || appliedFrom !== '' || appliedTo !== '';
  const isLastPage = rows.length < PAGE_SIZE;

  return (
    <section className="report-section">
      <h2>Daily aggregates</h2>
      <form onSubmit={applyFilter} className="filter-bar" role="search">
        <label htmlFor="agg-currency-filter">Currency</label>
        <input
          id="agg-currency-filter"
          autoComplete="off"
          placeholder="all currencies"
          value={currencyInput}
          onChange={(event) => setCurrencyInput(event.target.value)}
        />
        <label htmlFor="agg-type-filter">Type</label>
        <select
          id="agg-type-filter"
          value={typeInput}
          onChange={(event) => setTypeInput(event.target.value)}
        >
          <option value="">All types</option>
          {AGGREGATE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <label htmlFor="agg-from-filter">From</label>
        <input
          id="agg-from-filter"
          type="date"
          value={fromInput}
          onChange={(event) => setFromInput(event.target.value)}
        />
        <label htmlFor="agg-to-filter">To</label>
        <input
          id="agg-to-filter"
          type="date"
          value={toInput}
          onChange={(event) => setToInput(event.target.value)}
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
      {isError && <p role="alert">Failed to load daily aggregates ({describeApiError(error)}).</p>}
      {!isLoading && !isError && (
        <>
          <DailyAggregatesTable aggregates={rows} />
          <Pager
            page={page}
            isLastPage={isLastPage}
            onPrev={() => setPage((current) => Math.max(0, current - 1))}
            onNext={() => setPage((current) => current + 1)}
            label="Daily aggregate pages"
          />
        </>
      )}
    </section>
  );
}

/**
 * Account summaries section: filter by ownerId / currency, offset paging (limit 50). Same paging
 * rule as the aggregates section and `AuditPage`.
 */
function AccountSummariesSection() {
  const [ownerInput, setOwnerInput] = useState('');
  const [currencyInput, setCurrencyInput] = useState('');
  const [appliedOwner, setAppliedOwner] = useState('');
  const [appliedCurrency, setAppliedCurrency] = useState('');
  const [page, setPage] = useState(0);

  const offset = page * PAGE_SIZE;
  const {
    data: summaries,
    isLoading,
    isError,
    error,
  } = useGetAccountSummariesQuery({
    ownerId: appliedOwner || undefined,
    currency: appliedCurrency || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setAppliedOwner(ownerInput.trim());
    setAppliedCurrency(currencyInput.trim());
    setPage(0);
  }

  function clearFilter() {
    setOwnerInput('');
    setCurrencyInput('');
    setAppliedOwner('');
    setAppliedCurrency('');
    setPage(0);
  }

  const rows = summaries ?? [];
  const isFilterActive = appliedOwner !== '' || appliedCurrency !== '';
  const isLastPage = rows.length < PAGE_SIZE;

  return (
    <section className="report-section">
      <h2>Account summaries</h2>
      <form onSubmit={applyFilter} className="filter-bar" role="search">
        <label htmlFor="summary-owner-filter">Owner ID</label>
        <input
          id="summary-owner-filter"
          autoComplete="off"
          placeholder="all owners"
          value={ownerInput}
          onChange={(event) => setOwnerInput(event.target.value)}
        />
        <label htmlFor="summary-currency-filter">Currency</label>
        <input
          id="summary-currency-filter"
          autoComplete="off"
          placeholder="all currencies"
          value={currencyInput}
          onChange={(event) => setCurrencyInput(event.target.value)}
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
      {isError && <p role="alert">Failed to load account summaries ({describeApiError(error)}).</p>}
      {!isLoading && !isError && (
        <>
          <AccountSummariesTable summaries={rows} />
          <Pager
            page={page}
            isLastPage={isLastPage}
            onPrev={() => setPage((current) => Math.max(0, current - 1))}
            onNext={() => setPage((current) => current + 1)}
            label="Account summary pages"
          />
        </>
      )}
    </section>
  );
}

/** Offset pager shared by the two analytics sections — the exact `AuditPage` rule: **Previous** is
 * disabled on the first page (`offset 0`); **Next** is disabled when the current page returned a
 * short page (`rows.length < PAGE_SIZE`, i.e. the last page). */
function Pager({
  page,
  isLastPage,
  onPrev,
  onNext,
  label,
}: {
  page: number;
  isLastPage: boolean;
  onPrev: () => void;
  onNext: () => void;
  label: string;
}) {
  return (
    <nav className="pagination" aria-label={label}>
      <button type="button" className="btn btn--secondary" disabled={page === 0} onClick={onPrev}>
        Previous
      </button>
      <span className="pagination__status">Page {page + 1}</span>
      <button type="button" className="btn btn--secondary" disabled={isLastPage} onClick={onNext}>
        Next
      </button>
    </nav>
  );
}
