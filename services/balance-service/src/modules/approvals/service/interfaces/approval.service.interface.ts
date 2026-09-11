import { ApprovalRequest } from '../../../../database/entities/approval-request.entity';
import { ApprovalStatus } from '../../../../database/entities/enums';

/** DI token for {@link IApprovalService}. Consumers depend on the interface via this token, never
 * the concrete class. */
export const APPROVAL_SERVICE = Symbol('APPROVAL_SERVICE');

/** The admin approvals-list query ({@link IApprovalService.listApprovals}, `GET /admin/approvals`).
 * `status` is optional at the wire — the service DEFAULTS it to `PENDING` (the checker's queue). */
export interface ListApprovalsQuery {
  status?: ApprovalStatus;
}

/**
 * The maker-checker (four-eyes) reversal service (spec 04 "Admin ops" — reversals). A maker
 * PROPOSES a reversal of a POSTED internal transfer / external_inbound credit ({@link
 * proposeReversal}); a DIFFERENT checker then {@link approve}s (which executes the reversal
 * atomically) or {@link reject}s it. `checker_id <> maker_id` is enforced in the service and
 * backstopped by the DB CHECK. Every step writes one audit row.
 *
 * The methods return the plain {@link ApprovalRequest} entity; DTO serialization is a transport
 * concern applied at the controller boundary.
 */
export interface IApprovalService {
  /**
   * A maker proposes reversing a POSTED internal / external_inbound transaction. Validates the
   * target is reversible and guards against a duplicate request, then (in one tx) creates a
   * PENDING {@link ApprovalRequest} and writes the `reversal.proposed` audit row. No money moves.
   */
  proposeReversal(
    actorId: string,
    transactionId: string,
    reason?: string,
  ): Promise<ApprovalRequest>;

  /**
   * A checker (≠ the maker) approves a PENDING reversal, which EXECUTES it atomically: in one
   * deadlock-retried tx it flips the approval `PENDING → EXECUTED` (the maker-checker gate), flips
   * the original `POSTED → REVERSED` (the no-double-reversal gate), posts the FORCED compensating
   * movement (mirrored legs, `reverses_transaction_id`), and writes the `reversal.executed` audit
   * row. Returns the EXECUTED approval.
   */
  approve(actorId: string, approvalId: string): Promise<ApprovalRequest>;

  /**
   * A checker (≠ the maker) rejects a PENDING reversal: in one tx it flips the approval
   * `PENDING → REJECTED` and writes the `reversal.rejected` audit row. No money moves. Returns the
   * REJECTED approval.
   */
  reject(actorId: string, approvalId: string): Promise<ApprovalRequest>;

  /**
   * Admin `GET /admin/approvals` — list approval requests by status (spec 04 "Admin ops"). DEFAULTS
   * to `PENDING` (the checker's queue — where a checker discovers pending reversals to decide) when
   * the caller supplies no status, then delegates to the repository. A pure READ — it writes NO
   * audit row. Returns entities; the controller serializes them.
   */
  listApprovals(query: ListApprovalsQuery): Promise<ApprovalRequest[]>;
}
