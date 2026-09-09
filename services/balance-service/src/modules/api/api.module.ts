import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AccountsApiController } from '../accounts/api/accounts-api.controller';
import { OtpModule } from '../otp/otp.module';
import { OtpApiController } from '../otp/api/otp-api.controller';
import { TransfersModule } from '../transfers/transfers.module';
import { TransfersApiController } from '../transfers/api/transfers-api.controller';
import { ApiController } from './api.controller';

/**
 * The `/api` SURFACE registry (customer plane). It DECLARES every `/api` controller and
 * imports the feature modules for the services those controllers inject — the controller-
 * surface convention (see CLAUDE.md § Controller surfaces):
 * - `ApiController` — the foundation `whoami` guard probe.
 * - `AccountsApiController` — the accounts reads, injecting `ACCOUNTS_SERVICE` ({@link AccountsModule}).
 * - `TransfersApiController` — initiate/confirm/pending-authorizations, injecting
 *   `TRANSFERS_SERVICE` ({@link TransfersModule}).
 * - `OtpApiController` — mint the caller's one-time code, injecting `OTP_SERVICE`
 *   ({@link OtpModule}). `TransfersModule` also imports `OtpModule`; module singletons make the
 *   shared import safe.
 */
@Module({
  imports: [AccountsModule, TransfersModule, OtpModule],
  controllers: [ApiController, AccountsApiController, TransfersApiController, OtpApiController],
})
export class ApiModule {}
