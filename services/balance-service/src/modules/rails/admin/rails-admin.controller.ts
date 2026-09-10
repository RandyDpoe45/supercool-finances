import { Body, Controller, Inject, Post } from '@nestjs/common';
import { Identity } from '../../../common/identity/identity.decorator';
import { RequestIdentity } from '../../../common/identity/request-identity';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICE,
  IAuditService,
} from '../../audit/service/interfaces/audit.service.interface';
import { InboundCreditBody, inboundCreditSchema } from '../external/dto/rails.schema';
import { IRailsService, RAILS_SERVICE } from '../service/interfaces/rails.service.interface';
import { SimulatedInboundDto } from './dto/simulated-inbound.dto';
import { serializeSimulatedInbound } from './serializers/rails-admin.serializer';

/**
 * The rails feature's `/admin` surface controller (spec 04 "Admin ops" — trigger a SIMULATED
 * external inbound). DECLARED by {@link AdminModule}; the {@link RailsModule} feature module
 * provides + exports `RAILS_SERVICE` and {@link AuditModule} provides `AUDIT_SERVICE`, both
 * injected here.
 *
 * Under the global `/admin` prefix, role-gated by the {@link GatewayIdentityGuard} (`X-User-Id` +
 * `admin` role, else 403). It REUSES the exact rail inbound-credit path
 * ({@link IRailsService.creditInbound} — debit `clearing:rail-inbound`, credit the customer by
 * account number, idempotent by `externalRef`), then records the admin audit row via
 * {@link IAuditService.record} (its OWN tx): the credit already committed in the rails service's
 * own transaction and is idempotent by `externalRef`, so recording the audit after is safe (a retry
 * re-runs the idempotent credit + records again — an accepted minor duplicate, never a double
 * credit). The body mirrors the rail webhook's inbound schema (`.strict()`).
 */
@Controller('admin/external')
export class RailsAdminController {
  constructor(
    @Inject(RAILS_SERVICE) private readonly rails: IRailsService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  /** Trigger a simulated external inbound credit (reuses the rail inbound path). 201, the posted
   * credit transaction. Writes ONE audit row (`external.inbound.simulated`) after the credit. */
  @Post('inbound')
  async simulateInbound(
    @Body(new ZodValidationPipe(inboundCreditSchema)) body: InboundCreditBody,
    @Identity() identity: RequestIdentity,
  ): Promise<SimulatedInboundDto> {
    const transaction = await this.rails.creditInbound({
      accountNumber: body.accountNumber,
      amount: body.amount,
      currency: body.currency,
      externalRef: body.externalRef,
    });
    // Audit AFTER the (already-committed, idempotent) credit — its own tx. `targetId` is the
    // credited customer account (targetType 'account'); the human number + rail ref live in metadata.
    await this.audit.record({
      actorId: identity.userId,
      action: AUDIT_ACTIONS.EXTERNAL_INBOUND_SIMULATED,
      targetType: 'account',
      targetId: transaction.creditAccountId,
      metadata: {
        accountNumber: body.accountNumber,
        amount: body.amount,
        currency: body.currency,
        externalRef: body.externalRef,
        transactionId: transaction.id,
      },
    });
    return serializeSimulatedInbound(transaction);
  }
}
