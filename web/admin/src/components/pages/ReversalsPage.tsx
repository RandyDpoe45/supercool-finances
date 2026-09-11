import { useId, useState, type FormEvent } from 'react';
import { describeApiError } from '../../lib/apiError';
import {
  useApproveReversalMutation,
  useGetApprovalsQuery,
  useProposeReversalMutation,
  useRejectReversalMutation,
} from '../../services/api/approvalsApi';
import { useGetTransactionsQuery } from '../../services/api/transactionsApi';
import { ApprovalsQueue } from '../organisms/ApprovalsQueue';
import { TransactionsTable } from '../organisms/TransactionsTable';

/**
 * Maker-checker reversals (route `/reversals`). Two panels driven by the `/admin` contract:
 *
 * - **Transactions** — the admin transactions list (optionally owner-filtered, server-side). Clicking
 *   **Reverse** on a reversible row (the MAKER action) reveals an inline reason-capture form; Confirm
 *   PROPOSES the reversal (a PENDING approval), which the pending-approvals panel then shows. The
 *   maker id is resolved server-side, so the client sends only the optional reason.
 * - **Pending approvals** — the checker's queue. Approve EXECUTES the reversal atomically (the
 *   original flips to REVERSED and a compensating tx appears); Reject discards it. Four-eyes is
 *   enforced server-side (a maker cannot decide their own proposal → 403).
 *
 * `reversingId` / `pendingId` are threaded from each mutation's `originalArgs` so only the acting
 * row's button disables. Each organism surfaces its own action error via `describeApiError`; the
 * approve/reject banner picks the MOST-RECENT of the two (by `startedTimeStamp`) so a stale error
 * does not linger after a later successful action.
 */
export function ReversalsPage() {
  const [ownerInput, setOwnerInput] = useState('');
  const [appliedOwner, setAppliedOwner] = useState('');
  const [reverseTargetId, setReverseTargetId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const reasonId = useId();

  const {
    data: transactions,
    isLoading: isTransactionsLoading,
    isError: isTransactionsError,
    error: transactionsError,
  } = useGetTransactionsQuery(appliedOwner ? { ownerId: appliedOwner } : undefined);

  const {
    data: approvals,
    isLoading: isApprovalsLoading,
    isError: isApprovalsError,
    error: approvalsError,
  } = useGetApprovalsQuery();

  const [propose, proposeState] = useProposeReversalMutation();
  const [approve, approveState] = useApproveReversalMutation();
  const [reject, rejectState] = useRejectReversalMutation();

  // The proposal in flight targets a TRANSACTION (`originalArgs.transactionId`); the decision in
  // flight targets an APPROVAL (`originalArgs` is the approval id).
  const reversingId = proposeState.isLoading ? proposeState.originalArgs?.transactionId : undefined;
  const pendingId = approveState.isLoading
    ? approveState.originalArgs
    : rejectState.isLoading
      ? rejectState.originalArgs
      : undefined;

  // Surface only the most-recently-triggered decision's error, so a failed approve's banner does not
  // linger after a later SUCCESSFUL reject (each mutation hook retains its own last error).
  const approvalActionError =
    (rejectState.startedTimeStamp ?? 0) > (approveState.startedTimeStamp ?? 0)
      ? rejectState.error
      : approveState.error;

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    setAppliedOwner(ownerInput.trim());
  }

  function clearFilter() {
    setOwnerInput('');
    setAppliedOwner('');
  }

  function beginReverse(id: string) {
    setReverseTargetId(id);
    setReason('');
  }

  function cancelReverse() {
    setReverseTargetId(null);
    setReason('');
  }

  function confirmReverse(event: FormEvent) {
    event.preventDefault();
    if (reverseTargetId === null) {
      return;
    }
    const trimmed = reason.trim();
    // The reason is optional context: send it only when non-empty (the slice omits the body otherwise).
    void propose({ transactionId: reverseTargetId, reason: trimmed === '' ? undefined : trimmed });
    setReverseTargetId(null);
    setReason('');
  }

  return (
    <section>
      <h1>Reversals</h1>

      <h2>Transactions</h2>
      <form onSubmit={applyFilter} className="filter-bar" role="search">
        <label htmlFor="tx-owner-filter">Filter by owner ID</label>
        <input
          id="tx-owner-filter"
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

      {reverseTargetId !== null && (
        <form onSubmit={confirmReverse} className="reversal-form" aria-label="propose reversal">
          <p>
            Propose reversing transaction <code>{reverseTargetId}</code>. A second admin must
            approve before any money moves.
          </p>
          <label htmlFor={reasonId}>Reason (optional)</label>
          <input
            id={reasonId}
            autoComplete="off"
            maxLength={500}
            placeholder="why this is being reversed"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="form-actions">
            <button type="submit" className="btn btn--primary">
              Confirm reversal
            </button>
            <button type="button" className="btn btn--secondary" onClick={cancelReverse}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {isTransactionsLoading && <p>Loading…</p>}
      {isTransactionsError && (
        <p role="alert">Failed to load transactions ({describeApiError(transactionsError)}).</p>
      )}
      {!isTransactionsLoading && !isTransactionsError && (
        <TransactionsTable
          transactions={transactions ?? []}
          onReverse={beginReverse}
          reversingId={reversingId}
          actionError={proposeState.error}
        />
      )}

      <h2>Pending approvals</h2>
      {isApprovalsLoading && <p>Loading…</p>}
      {isApprovalsError && (
        <p role="alert">Failed to load approvals ({describeApiError(approvalsError)}).</p>
      )}
      {!isApprovalsLoading && !isApprovalsError && (
        <ApprovalsQueue
          approvals={approvals ?? []}
          onApprove={(id) => void approve(id)}
          onReject={(id) => void reject(id)}
          pendingId={pendingId}
          actionError={approvalActionError}
        />
      )}
    </section>
  );
}
