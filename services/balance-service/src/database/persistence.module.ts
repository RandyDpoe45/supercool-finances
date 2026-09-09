import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Account } from './entities/account.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { Transaction } from './entities/transaction.entity';
import { Hold } from './entities/hold.entity';
import { ExternalPayee } from './entities/external-payee.entity';
import { UserLimits } from './entities/user-limits.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { AuditLog } from './entities/audit-log.entity';
import { ApprovalRequest } from './entities/approval-request.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';

import { ACCOUNT_REPOSITORY } from './repositories/interfaces/account.repository.interface';
import { AccountRepository } from './repositories/impl/account.repository';
import { LEDGER_ENTRY_REPOSITORY } from './repositories/interfaces/ledger-entry.repository.interface';
import { LedgerEntryRepository } from './repositories/impl/ledger-entry.repository';
import { TRANSACTION_REPOSITORY } from './repositories/interfaces/transaction.repository.interface';
import { TransactionRepository } from './repositories/impl/transaction.repository';
import { HOLD_REPOSITORY } from './repositories/interfaces/hold.repository.interface';
import { HoldRepository } from './repositories/impl/hold.repository';
import { EXTERNAL_PAYEE_REPOSITORY } from './repositories/interfaces/external-payee.repository.interface';
import { ExternalPayeeRepository } from './repositories/impl/external-payee.repository';
import { USER_LIMITS_REPOSITORY } from './repositories/interfaces/user-limits.repository.interface';
import { UserLimitsRepository } from './repositories/impl/user-limits.repository';
import { OUTBOX_EVENT_REPOSITORY } from './repositories/interfaces/outbox-event.repository.interface';
import { OutboxEventRepository } from './repositories/impl/outbox-event.repository';
import { AUDIT_LOG_REPOSITORY } from './repositories/interfaces/audit-log.repository.interface';
import { AuditLogRepository } from './repositories/impl/audit-log.repository';
import { APPROVAL_REQUEST_REPOSITORY } from './repositories/interfaces/approval-request.repository.interface';
import { ApprovalRequestRepository } from './repositories/impl/approval-request.repository';
import { IDEMPOTENCY_KEY_REPOSITORY } from './repositories/interfaces/idempotency-key.repository.interface';
import { IdempotencyKeyRepository } from './repositories/impl/idempotency-key.repository';

/**
 * Binds each aggregate's repository interface (token) to its TypeORM implementation and
 * exports the tokens, so the domain modules inject the interfaces — never the concrete
 * classes. `TypeOrmModule.forFeature` registers the entity repositories the impls receive
 * via `@InjectRepository`; it relies on the default connection wired by
 * {@link DatabaseModule} (no second connection).
 *
 * Wired into the app graph from spec 04's first domain slice: {@link AccountsModule} imports
 * this module for its owner-scoped account reads. Later domain modules import it the same way.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Account,
      LedgerEntry,
      Transaction,
      Hold,
      ExternalPayee,
      UserLimits,
      OutboxEvent,
      AuditLog,
      ApprovalRequest,
      IdempotencyKey,
    ]),
  ],
  providers: [
    { provide: ACCOUNT_REPOSITORY, useClass: AccountRepository },
    { provide: LEDGER_ENTRY_REPOSITORY, useClass: LedgerEntryRepository },
    { provide: TRANSACTION_REPOSITORY, useClass: TransactionRepository },
    { provide: HOLD_REPOSITORY, useClass: HoldRepository },
    { provide: EXTERNAL_PAYEE_REPOSITORY, useClass: ExternalPayeeRepository },
    { provide: USER_LIMITS_REPOSITORY, useClass: UserLimitsRepository },
    { provide: OUTBOX_EVENT_REPOSITORY, useClass: OutboxEventRepository },
    { provide: AUDIT_LOG_REPOSITORY, useClass: AuditLogRepository },
    { provide: APPROVAL_REQUEST_REPOSITORY, useClass: ApprovalRequestRepository },
    { provide: IDEMPOTENCY_KEY_REPOSITORY, useClass: IdempotencyKeyRepository },
  ],
  exports: [
    ACCOUNT_REPOSITORY,
    LEDGER_ENTRY_REPOSITORY,
    TRANSACTION_REPOSITORY,
    HOLD_REPOSITORY,
    EXTERNAL_PAYEE_REPOSITORY,
    USER_LIMITS_REPOSITORY,
    OUTBOX_EVENT_REPOSITORY,
    AUDIT_LOG_REPOSITORY,
    APPROVAL_REQUEST_REPOSITORY,
    IDEMPOTENCY_KEY_REPOSITORY,
  ],
})
export class PersistenceModule {}
