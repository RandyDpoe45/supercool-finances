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
import { ResolveDestinationDto } from './dto/resolve-destination.dto';
import { TransferDto } from './dto/transfer.dto';
import {
  ConfirmTransferBody,
  confirmTransferSchema,
  idempotencyKeySchema,
  InitiateTransferBody,
  initiateTransferSchema,
  ResolveDestinationBody,
  resolveDestinationSchema,
} from './dto/transfers.schema';
import {
  serializePendingAuthorization,
  serializeResolveDestination,
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

  /**
   * Confirmation of payee: resolve a destination account number to the masked holder name + a
   * single-use confirmation token. A pure QUERY — moves no money; the token gates initiate. 200.
   */
  @Post('transfers/resolve-destination')
  @HttpCode(HttpStatus.OK)
  async resolveDestination(
    @Body(new ZodValidationPipe(resolveDestinationSchema)) body: ResolveDestinationBody,
    @Identity() identity: RequestIdentity,
  ): Promise<ResolveDestinationDto> {
    const resolution = await this.transfers.resolveDestination({
      ownerId: identity.userId,
      accountNumber: body.accountNumber,
    });
    return serializeResolveDestination(resolution);
  }

  /** Initiate an internal transfer — creates a PENDING transaction (no money moves). Requires a
   * confirmation token from `resolve-destination` bound to the destination. 201. */
  @Post('transfers')
  async initiate(
    @Body(new ZodValidationPipe(initiateTransferSchema)) body: InitiateTransferBody,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Identity() identity: RequestIdentity,
  ): Promise<TransferDto> {
    const idempotencyKey = idempotencyKeyPipe.transform(idempotencyKeyHeader) as string;
    const tx = await this.transfers.initiateTransfer({
      ownerId: identity.userId,
      sourceAccountId: body.sourceAccountId,
      destinationAccountNumber: body.destinationAccountNumber,
      amount: body.amount,
      currency: body.currency,
      idempotencyKey,
      confirmationToken: body.confirmationToken,
      confirmDuplicate: body.confirmDuplicate,
    });
    return serializeTransfer(tx);
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
    const tx = await this.transfers.confirmTransfer({
      ownerId: identity.userId,
      transferId: id,
      code: body.code,
    });
    return serializeTransfer(tx);
  }

  /** Cancel the caller's PENDING transfer (guarded `PENDING → CANCELLED`, retained). Idempotent
   * on an already CANCELLED/EXPIRED transfer; a POSTED one cannot be cancelled (409). 200. */
  @Post('transfers/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Identity() identity: RequestIdentity,
  ): Promise<TransferDto> {
    const tx = await this.transfers.cancelTransfer({
      ownerId: identity.userId,
      transferId: id,
    });
    return serializeTransfer(tx);
  }

  /** The caller's SINGLE active pending transfer awaiting confirm (the OTP app's feed), or none.
   * Reading lazily expires an overdue pending. 200, `{ authorization: … | null }`. */
  @Get('pending-authorization')
  async getPending(
    @Identity() identity: RequestIdentity,
  ): Promise<{ authorization: PendingAuthorizationDto | null }> {
    const pending = await this.transfers.getPendingAuthorization(identity.userId);
    return { authorization: pending ? serializePendingAuthorization(pending) : null };
  }
}
