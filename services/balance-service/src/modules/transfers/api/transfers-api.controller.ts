import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Identity } from '../../../common/identity/identity.decorator';
import { RequestIdentity } from '../../../common/identity/request-identity';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import {
  ITransfersService,
  TRANSFERS_SERVICE,
} from '../service/interfaces/transfers.service.interface';
import { PendingAuthorizationDto } from './dto/pending-authorization.dto';
import { TransferDto } from './dto/transfer.dto';
import {
  ConfirmTransferBody,
  confirmTransferSchema,
  idempotencyKeySchema,
  InitiateTransferBody,
  initiateTransferSchema,
} from './dto/transfers.schema';
import {
  serializePendingAuthorization,
  serializeTransfer,
} from './serializers/transfers.serializer';

/** The Idempotency-Key header is validated with the same reusable pipe as the bodies, applied
 * MANUALLY because `@Headers()` (unlike `@Body`/`@Param`) does not accept a pipe. A missing or
 * empty header fails the schema → `BadRequestException` (400). */
const idempotencyKeyPipe = new ZodValidationPipe(idempotencyKeySchema);

/**
 * The transfers feature's `/api` surface controller (spec 04, step 4b — internal transfers).
 * DECLARED by {@link ApiModule}; the {@link TransfersModule} feature module provides + exports
 * the service behind the `TRANSFERS_SERVICE` token, injected here as `ITransfersService`.
 *
 * Under the global `/api` prefix, so {@link GatewayIdentityGuard} has already required the Kong
 * `X-User-Id` — the caller id is taken from `@Identity()`, never a body/query field. Request
 * bodies and the `Idempotency-Key` header are validated by the {@link ZodValidationPipe}
 * (malformed → 400); the service returns entities, serialized to DTOs at this boundary.
 */
@Controller('api')
export class TransfersApiController {
  constructor(@Inject(TRANSFERS_SERVICE) private readonly transfers: ITransfersService) {}

  /** Initiate an internal transfer — creates a PENDING transaction (no money moves). 201. */
  @Post('transfers')
  async initiate(
    @Body(new ZodValidationPipe(initiateTransferSchema)) body: InitiateTransferBody,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Identity() identity: RequestIdentity,
  ): Promise<TransferDto> {
    const idempotencyKey = idempotencyKeyPipe.transform(idempotencyKeyHeader) as string;
    const transfer = await this.transfers.initiateTransfer({
      ownerId: identity.userId,
      sourceAccountId: body.sourceAccountId,
      destinationAccountId: body.destinationAccountId,
      amount: body.amount,
      currency: body.currency,
      idempotencyKey,
      confirmDuplicate: body.confirmDuplicate,
    });
    return serializeTransfer(transfer);
  }

  /** Confirm a PENDING transfer with the caller's one-time code — posts it (money moves). 200. */
  @Post('transfers/:id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    // ParseUUIDPipe rejects a malformed id with 400 before any DB access.
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(confirmTransferSchema)) body: ConfirmTransferBody,
    @Identity() identity: RequestIdentity,
  ): Promise<TransferDto> {
    const transfer = await this.transfers.confirmTransfer({
      ownerId: identity.userId,
      transferId: id,
      code: body.code,
    });
    return serializeTransfer(transfer);
  }

  /** The caller's PENDING transfers awaiting confirm (the OTP app's feed). 200. */
  @Get('pending-authorizations')
  async listPending(
    @Identity() identity: RequestIdentity,
  ): Promise<{ authorizations: PendingAuthorizationDto[] }> {
    const pending = await this.transfers.listPendingAuthorizations(identity.userId);
    return { authorizations: pending.map(serializePendingAuthorization) };
  }
}
