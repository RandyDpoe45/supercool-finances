import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

/**
 * First domain slice of spec 04 (read-only accounts). Importing {@link PersistenceModule}
 * here is what finally wires it into the running app graph: the service injects the
 * repository interfaces by token (`ACCOUNT_REPOSITORY`, `LEDGER_ENTRY_REPOSITORY`), never
 * the concrete classes.
 */
@Module({
  imports: [PersistenceModule],
  controllers: [AccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
