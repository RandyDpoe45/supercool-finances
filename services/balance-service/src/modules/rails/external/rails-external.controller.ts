import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { IRailsService, RAILS_SERVICE } from '../service/interfaces/rails.service.interface';
import { RailAckDto } from './dto/rail-ack.dto';
import {
  InboundCreditBody,
  inboundCreditSchema,
  SettlementCallbackBody,
  settlementCallbackSchema,
} from './dto/rails.schema';
import { serializeRailAck } from './serializers/rails.serializer';

/**
 * The rails feature's `/external` surface controller (spec 04, step 5c — mocked external rails).
 * DECLARED by {@link ExternalModule}; the {@link RailsModule} feature module provides + exports
 * the service behind the `RAILS_SERVICE` token, injected here as `IRailsService`.
 *
 * Under the global `/external` prefix — a DISTINCT trust domain guarded by the
 * `RailSignatureGuard` (the third-party rail's HMAC `X-Rail-Signature` over the raw body, NOT a
 * user JWT or the service token). Request bodies are validated by the {@link ZodValidationPipe}
 * (`.strict()` schemas,
 * malformed → 400); the service returns entities, serialized to a minimal ack DTO at this
 * boundary (no PII / internal leak). Both endpoints are idempotent, so a retried webhook is a
 * safe no-op that returns the same 200 ack.
 */
@Controller('external')
export class RailsExternalController {
  constructor(@Inject(RAILS_SERVICE) private readonly rails: IRailsService) {}

  /** Outbound completion: SUCCESS reconciles (records the rail ref, no new ledger post); FAILURE
   * reverses (`clearing → customer`, original → REVERSED). Correlated by our transaction id,
   * idempotent. 200, `{ status: 'ok', transactionId }` (the original transfer id). */
  @Post('rails/settlement-callback')
  @HttpCode(HttpStatus.OK)
  async settlementCallback(
    @Body(new ZodValidationPipe(settlementCallbackSchema)) body: SettlementCallbackBody,
  ): Promise<RailAckDto> {
    const transfer = await this.rails.settleOutbound({
      transactionId: body.transactionId,
      status: body.status,
      externalRef: body.externalRef,
    });
    return serializeRailAck(transfer);
  }

  /** External inbound credit: a fresh POSTED `external_inbound` movement debiting
   * `clearing:rail-inbound` and crediting the customer resolved by account number. NOT OTP-gated,
   * idempotent by the rail `externalRef`. 200, `{ status: 'ok', transactionId }` (the posted id). */
  @Post('rails/inbound')
  @HttpCode(HttpStatus.OK)
  async inbound(
    @Body(new ZodValidationPipe(inboundCreditSchema)) body: InboundCreditBody,
  ): Promise<RailAckDto> {
    const transaction = await this.rails.creditInbound({
      accountNumber: body.accountNumber,
      amount: body.amount,
      currency: body.currency,
      externalRef: body.externalRef,
    });
    return serializeRailAck(transaction);
  }
}
