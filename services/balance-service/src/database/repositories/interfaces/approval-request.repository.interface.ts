import { DeepPartial } from 'typeorm';
import { ApprovalRequest } from '../../entities/approval-request.entity';

/** DI token for {@link IApprovalRequestRepository}. */
export const APPROVAL_REQUEST_REPOSITORY = Symbol('APPROVAL_REQUEST_REPOSITORY');

/** Persistence port for {@link ApprovalRequest} (maker-checker). Approve/reject/execute
 * status transitions are enforced in the domain step. */
export interface IApprovalRequestRepository {
  findById(id: string): Promise<ApprovalRequest | null>;
  create(data: DeepPartial<ApprovalRequest>): Promise<ApprovalRequest>;
}
