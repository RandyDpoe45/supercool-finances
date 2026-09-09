import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { AccountsService } from './impl/accounts.service';
import { ACCOUNTS_SERVICE } from './interfaces/accounts.service.interface';

/**
 * The accounts FEATURE module. It owns the accounts domain service and its surface
 * controller FILES (`accounts-api.controller.ts`), but declares no controllers of its own:
 * per the controller-surface convention, the per-surface registry modules ({@link ApiModule}
 * for `/api`) DECLARE the controllers, and this feature module simply provides + **exports**
 * the accounts service behind the `ACCOUNTS_SERVICE` token (interface/impl split — consumers
 * depend on `IAccountsService`, never the concrete class). Importing {@link PersistenceModule}
 * wires the repository interface tokens (`ACCOUNT_REPOSITORY`, `LEDGER_ENTRY_REPOSITORY`) the
 * service depends on by token, never the concrete classes.
 */
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: ACCOUNTS_SERVICE, useClass: AccountsService }],
  exports: [ACCOUNTS_SERVICE],
})
export class AccountsModule {}
