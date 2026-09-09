import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { AccountsService } from './accounts.service';

/**
 * The accounts FEATURE module. It owns the accounts domain service and its surface
 * controller FILES (`accounts-api.controller.ts`), but declares no controllers of its own:
 * per the controller-surface convention, the per-surface registry modules ({@link ApiModule}
 * for `/api`) DECLARE the controllers, and this feature module simply provides + **exports**
 * {@link AccountsService} for them to inject. Importing {@link PersistenceModule} wires the
 * repository interface tokens (`ACCOUNT_REPOSITORY`, `LEDGER_ENTRY_REPOSITORY`) the service
 * depends on by token, never the concrete classes.
 */
@Module({
  imports: [PersistenceModule],
  providers: [AccountsService],
  exports: [AccountsService],
})
export class AccountsModule {}
