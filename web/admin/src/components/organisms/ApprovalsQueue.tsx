import { describeApiError } from '../../lib/apiError';
import type { ApprovalRequestDto } from '../../services/api/contracts/approval';
import { Alert } from '../atoms/Alert';
import { StatusBadge } from '../atoms/StatusBadge';
import { Timestamp } from '../atoms/Timestamp';

/**
 * The maker-checker approval queue as a table: approval id + action type, a status badge, the target
 * transaction, the maker, and when it was proposed (Mexico City). Each row offers **Approve** +
 * **Reject** (the checker's decision); both disable while THIS row's decision is in flight
 * (`pendingId`). The server enforces four-eyes — a maker cannot decide their own proposal — and 403s
 * (`SELF_APPROVAL_FORBIDDEN`) if attempted; a failed action surfaces via the `Alert` atom. Empty
 * state ("No pending approvals.") is owned here; the page owns the read query's loading/error and the
 * mutation hooks.
 */
export function ApprovalsQueue({
  approvals,
  onApprove,
  onReject,
  pendingId,
  actionError,
}: {
  approvals: ApprovalRequestDto[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  pendingId?: string;
  actionError?: unknown;
}) {
  if (approvals.length === 0) {
    return <p>No pending approvals.</p>;
  }
  return (
    <>
      {actionError !== undefined && (
        <Alert variant="error">Approval action failed ({describeApiError(actionError)}).</Alert>
      )}
      <table aria-label="approvals" className="data-table">
        <thead>
          <tr>
            <th scope="col">Approval</th>
            <th scope="col">Status</th>
            <th scope="col">Target transaction</th>
            <th scope="col">Maker</th>
            <th scope="col">Created (Mexico City)</th>
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          {approvals.map((approval) => {
            const isPending = pendingId === approval.id;
            return (
              <tr key={approval.id} data-approval-id={approval.id}>
                <td className="data-table__ref">
                  {approval.id}
                  <span className="data-table__muted"> ({approval.actionType})</span>
                </td>
                <td>
                  <StatusBadge status={approval.status} />
                </td>
                <td className="data-table__ref">{approval.targetTransactionId ?? '—'}</td>
                <td className="data-table__ref">{approval.makerId}</td>
                <td>
                  <Timestamp iso={approval.createdAt} />
                </td>
                <td className="approval-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={isPending}
                    onClick={() => onApprove(approval.id)}
                  >
                    {isPending ? 'Working…' : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    disabled={isPending}
                    onClick={() => onReject(approval.id)}
                  >
                    {isPending ? 'Working…' : 'Reject'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
