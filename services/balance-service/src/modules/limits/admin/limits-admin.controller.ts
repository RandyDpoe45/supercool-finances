import { Body, Controller, HttpCode, HttpStatus, Inject, Put } from '@nestjs/common';
import { Identity } from '../../../common/identity/identity.decorator';
import { RequestIdentity } from '../../../common/identity/request-identity';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { ILimitsService, LIMITS_SERVICE } from '../service/interfaces/limits.service.interface';
import { LimitsDto } from './dto/limits.dto';
import { UpsertLimitsBody, upsertLimitsSchema } from './dto/limits.schema';
import { serializeLimits } from './serializers/limits.serializer';

/**
 * The limits feature's `/admin` surface controller (spec 04 "Admin ops" — single-actor
 * `PUT /limits`). DECLARED by {@link AdminModule}; the {@link LimitsModule} feature module provides
 * + exports the service behind the `LIMITS_SERVICE` token, injected here as `ILimitsService`.
 *
 * Under the global `/admin` prefix, role-gated by the {@link GatewayIdentityGuard} (`X-User-Id` +
 * `admin` role, else 403). The actor id is read ONLY via `@Identity()` and recorded as the audit
 * `actorId`. The body is validated by the {@link ZodValidationPipe} (`.strict()`, malformed → 400);
 * the service returns the entity, serialized to a DTO at this boundary.
 */
@Controller('admin/limits')
export class LimitsAdminController {
  constructor(@Inject(LIMITS_SERVICE) private readonly limits: ILimitsService) {}

  /** Upsert the global baseline or a per-customer override; writes ONE audit row in the same tx.
   * 200, the resulting limits row. */
  @Put()
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Body(new ZodValidationPipe(upsertLimitsSchema)) body: UpsertLimitsBody,
    @Identity() identity: RequestIdentity,
  ): Promise<LimitsDto> {
    const row = await this.limits.upsertLimits(identity.userId, {
      scope: body.scope,
      ownerId: body.ownerId ?? null,
      currency: body.currency,
      perTransactionMax: body.perTransactionMax ?? null,
      dailyMax: body.dailyMax ?? null,
      monthlyMax: body.monthlyMax ?? null,
    });
    return serializeLimits(row);
  }
}
