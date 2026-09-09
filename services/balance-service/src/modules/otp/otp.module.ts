import { Module } from '@nestjs/common';
import { OtpService } from './service/impl/otp.service';
import { OTP_SERVICE } from './service/interfaces/otp.service.interface';

/**
 * The OTP domain module. Provides the user-scoped one-time code service (spec 04 OTP module)
 * bound behind the `OTP_SERVICE` token (interface/impl split — consumers depend on
 * `IOtpService`, never the concrete class). The `REDIS_CLIENT` the service injects comes from
 * the `@Global` {@link RedisModule} (imported once in AppModule), so it is NOT imported here.
 * Exported so the transfers surface module (step 4b) can depend on it. No controller — this
 * step has no HTTP surface.
 */
@Module({
  providers: [{ provide: OTP_SERVICE, useClass: OtpService }],
  exports: [OTP_SERVICE],
})
export class OtpModule {}
