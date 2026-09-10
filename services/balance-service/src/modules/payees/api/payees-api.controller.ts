import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { Identity } from '../../../common/identity/identity.decorator';
import { RequestIdentity } from '../../../common/identity/request-identity';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { IPayeesService, PAYEES_SERVICE } from '../service/interfaces/payees.service.interface';
import { PayeeDto } from './dto/payee.dto';
import { RegisterPayeeBody, registerPayeeSchema } from './dto/payees.schema';
import { serializePayee } from './serializers/payees.serializer';

/**
 * The payees feature's `/api` surface controller (spec 04 "External payees"). DECLARED by
 * {@link ApiModule}; the {@link PayeesModule} feature module provides + exports the service behind
 * the `PAYEES_SERVICE` token, injected here as `IPayeesService`.
 *
 * Under the global `/api` prefix, so {@link GatewayIdentityGuard} has already required the Kong
 * `X-User-Id` — the caller id is taken from `@Identity()`, never a body/query field. The request
 * body is validated by the {@link ZodValidationPipe} (malformed → 400); the service returns
 * entities, serialized to DTOs at this boundary.
 */
@Controller('api')
export class PayeesApiController {
  constructor(@Inject(PAYEES_SERVICE) private readonly payees: IPayeesService) {}

  /** Enroll an external beneficiary. Minimal body `{ displayName, destinationRef }`; the outbound
   * rail is a server-side constant. Stamps the DB-clock `coolingOffUntil`. 201. */
  @Post('payees')
  async register(
    @Body(new ZodValidationPipe(registerPayeeSchema)) body: RegisterPayeeBody,
    @Identity() identity: RequestIdentity,
  ): Promise<PayeeDto> {
    const payee = await this.payees.registerPayee({
      ownerId: identity.userId,
      displayName: body.displayName,
      destinationRef: body.destinationRef,
    });
    return serializePayee(payee);
  }

  /** List the caller's enrolled payees. 200, `{ payees: PayeeDto[] }`. */
  @Get('payees')
  async list(@Identity() identity: RequestIdentity): Promise<{ payees: PayeeDto[] }> {
    const payees = await this.payees.listPayees(identity.userId);
    return { payees: payees.map(serializePayee) };
  }
}
