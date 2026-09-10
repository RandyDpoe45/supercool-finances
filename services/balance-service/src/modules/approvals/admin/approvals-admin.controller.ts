import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Identity } from '../../../common/identity/identity.decorator';
import { RequestIdentity } from '../../../common/identity/request-identity';
import {
  APPROVAL_SERVICE,
  IApprovalService,
} from '../service/interfaces/approval.service.interface';
import { ApprovalRequestDto } from './dto/approval-request.dto';
import { serializeApprovalRequest } from './serializers/approval-request.serializer';

/**
 * The checker side of maker-checker reversals (spec 04 "Admin ops" — a DIFFERENT checker decides).
 * DECLARED by {@link AdminModule}; the {@link ApprovalsModule} feature module provides + exports
 * `APPROVAL_SERVICE`, injected here as `IApprovalService`.
 *
 * Under the `/admin` surface, role-gated by the {@link GatewayIdentityGuard} (`X-User-Id` + the
 * `admin` role, else 403). The checker id is read ONLY via `@Identity()` (`identity.userId`) — the
 * service rejects a self-approval (`checker <> maker`, the DB CHECK backstops). **Approve executes
 * the reversal atomically** (money moves via the reducer); reject moves no money. Each writes ONE
 * audit row.
 */
@Controller('admin/approvals')
export class ApprovalsAdminController {
  constructor(@Inject(APPROVAL_SERVICE) private readonly approvals: IApprovalService) {}

  /** Approve a PENDING reversal — EXECUTES it (guarded PENDING→EXECUTED + POSTED→REVERSED + the
   * FORCED compensating post, all in one tx). `:id` (the approval) via `ParseUUIDPipe`. 200, the
   * EXECUTED approval. */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Identity() identity: RequestIdentity,
  ): Promise<ApprovalRequestDto> {
    const approval = await this.approvals.approve(identity.userId, id);
    return serializeApprovalRequest(approval);
  }

  /** Reject a PENDING reversal (guarded PENDING→REJECTED). No money moves. `:id` (the approval) via
   * `ParseUUIDPipe`. 200, the REJECTED approval. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Identity() identity: RequestIdentity,
  ): Promise<ApprovalRequestDto> {
    const approval = await this.approvals.reject(identity.userId, id);
    return serializeApprovalRequest(approval);
  }
}
