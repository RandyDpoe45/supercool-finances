import { Body, Controller, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Identity } from '../../../common/identity/identity.decorator';
import { RequestIdentity } from '../../../common/identity/request-identity';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import {
  APPROVAL_SERVICE,
  IApprovalService,
} from '../service/interfaces/approval.service.interface';
import { ApprovalRequestDto } from './dto/approval-request.dto';
import { ProposeReversalBody, proposeReversalSchema } from './dto/reverse.schema';
import { serializeApprovalRequest } from './serializers/approval-request.serializer';

/**
 * The maker side of maker-checker reversals (spec 04 "Admin ops" — a maker PROPOSES a reversal).
 * DECLARED by {@link AdminModule}; the {@link ApprovalsModule} feature module provides + exports
 * `APPROVAL_SERVICE`, injected here as `IApprovalService`.
 *
 * Under the `/admin` surface, role-gated by the {@link GatewayIdentityGuard} (`X-User-Id` + the
 * `admin` role, else 403). The maker id is read ONLY via `@Identity()` (`identity.userId`) — never
 * the body/query. Proposing writes ONE audit row (`reversal.proposed`) and moves NO money; the
 * checker's approve/reject lives on {@link ApprovalsAdminController}.
 */
@Controller('admin/transfers')
export class ReversalsAdminController {
  constructor(@Inject(APPROVAL_SERVICE) private readonly approvals: IApprovalService) {}

  /** Propose reversing a POSTED internal / external_inbound transfer → a PENDING ApprovalRequest.
   * `:id` (the target transaction) is validated by `ParseUUIDPipe` (400 before any DB access); the
   * optional body carries a free-form `reason`. 201, the PENDING approval (admin view). */
  @Post(':id/reverse')
  async propose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(proposeReversalSchema)) body: ProposeReversalBody,
    @Identity() identity: RequestIdentity,
  ): Promise<ApprovalRequestDto> {
    const approval = await this.approvals.proposeReversal(identity.userId, id, body.reason);
    return serializeApprovalRequest(approval);
  }
}
