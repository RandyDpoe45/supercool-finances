import { Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { Identity } from '../../../common/identity/identity.decorator';
import { RequestIdentity } from '../../../common/identity/request-identity';
import { IOtpService, OTP_SERVICE } from '../service/interfaces/otp.service.interface';
import { OtpDto } from './dto/otp.dto';
import { serializeOtp } from './serializers/otp.serializer';

/**
 * The OTP feature's `/api` surface controller — mints the caller's user-scoped one-time code
 * (spec 04 OTP module). DECLARED by {@link ApiModule}; the {@link OtpModule} feature module
 * provides + exports the service behind the `OTP_SERVICE` token, which this controller injects
 * as `IOtpService`.
 *
 * Under the global `/api` prefix, so {@link GatewayIdentityGuard} has already required the Kong
 * `X-User-Id` — the code is scoped to `@Identity().userId`, never a body/query field.
 * Singleton-gated: a second `POST /api/otp` while a code is active raises `OtpAlreadyActiveError`
 * → 409 via the global filter.
 */
@Controller('api')
export class OtpApiController {
  constructor(@Inject(OTP_SERVICE) private readonly otp: IOtpService) {}

  /** Mint the caller's user-scoped one-time code (no resource is created at a new URL). 200. */
  @Post('otp')
  @HttpCode(HttpStatus.OK)
  async generate(@Identity() identity: RequestIdentity): Promise<OtpDto> {
    const result = await this.otp.generate(identity.userId);
    return serializeOtp(result);
  }
}
