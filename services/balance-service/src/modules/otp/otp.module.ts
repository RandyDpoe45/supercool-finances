import { Module } from '@nestjs/common';
import { OtpService } from './service/impl/otp.service';
import { OTP_SERVICE } from './service/interfaces/otp.service.interface';

/**
 * The OTP FEATURE module. Provides + exports the user-scoped one-time code service (spec 04 OTP
 * module) behind the `OTP_SERVICE` token (interface/impl split — consumers depend on
 * `IOtpService`, never the concrete class). It owns its `/api` surface controller FILE
 * (`api/otp-api.controller.ts`) but declares no controllers of its own: per the controller-
 * surface convention {@link ApiModule} DECLARES `OtpApiController` and imports this module for
 * the service. It is also imported by {@link TransfersModule} (the confirm flow consumes the
 * service). The `REDIS_CLIENT` + `APP_CONFIG` the service injects come from `@Global` modules,
 * so they are NOT imported here.
 */
@Module({
  providers: [{ provide: OTP_SERVICE, useClass: OtpService }],
  exports: [OTP_SERVICE],
})
export class OtpModule {}
