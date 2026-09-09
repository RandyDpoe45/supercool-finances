import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AccountsApiController } from '../accounts/accounts-api.controller';
import { ApiController } from './api.controller';

/**
 * The `/api` SURFACE registry (customer plane). It DECLARES every `/api` controller and
 * imports the feature modules for the services those controllers inject — the controller-
 * surface convention (see CLAUDE.md § Controller surfaces). `ApiController` is the
 * foundation `whoami` guard probe; `AccountsApiController` is the accounts feature's `/api`
 * surface controller, injecting the `AccountsService` that {@link AccountsModule} exports.
 */
@Module({
  imports: [AccountsModule],
  controllers: [ApiController, AccountsApiController],
})
export class ApiModule {}
