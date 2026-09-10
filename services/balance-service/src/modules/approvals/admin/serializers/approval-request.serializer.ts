import { ApprovalRequest } from '../../../../database/entities/approval-request.entity';
import { ApprovalRequestDto } from '../dto/approval-request.dto';

/**
 * The anti-leak transport boundary for the maker-checker reversal responses: an explicit whitelist
 * that lists every output field by hand and MUST NOT spread the entity. Adding a field is a
 * deliberate act. The free-form `payload` blob is intentionally NOT surfaced. Timestamps render as
 * ISO-8601 UTC instants; `decidedAt` / `executedAt` are null while the request is still PENDING.
 */
export function serializeApprovalRequest(approval: ApprovalRequest): ApprovalRequestDto {
  return {
    id: approval.id,
    actionType: approval.actionType,
    status: approval.status,
    makerId: approval.makerId,
    checkerId: approval.checkerId,
    targetTransactionId: approval.targetTransactionId,
    createdAt: approval.createdAt.toISOString(),
    decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
    executedAt: approval.executedAt ? approval.executedAt.toISOString() : null,
  };
}
