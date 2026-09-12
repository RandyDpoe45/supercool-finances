import { DataSourceOptions } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { AppMetadata } from './entities/app-metadata.entity';
import { Currency } from './entities/currency.entity';
import { Customer } from './entities/customer.entity';
import { Account } from './entities/account.entity';
import { ExternalPayee } from './entities/external-payee.entity';
import { Transaction } from './entities/transaction.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { Hold } from './entities/hold.entity';
import { UserLimits } from './entities/user-limits.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { AuditLog } from './entities/audit-log.entity';
import { ApprovalRequest } from './entities/approval-request.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { CreateAppMetadata1725000000000 } from './migrations/1725000000000-CreateAppMetadata';
import { CreateBalanceCore1788825600000 } from './migrations/1788825600000-CreateBalanceCore';
import { CreateBalanceSatellites1788912000000 } from './migrations/1788912000000-CreateBalanceSatellites';
import { SeedSystemAccounts1788998400000 } from './migrations/1788998400000-SeedSystemAccounts';
import { CreateCustomerAndAccountNumber1789084800000 } from './migrations/1789084800000-CreateCustomerAndAccountNumber';
import { AddTransactionLifecycle1789171200000 } from './migrations/1789171200000-AddTransactionLifecycle';
import { SeedBaselineUserLimits1789257600000 } from './migrations/1789257600000-SeedBaselineUserLimits';
import { AddAccountLabel1789344000000 } from './migrations/1789344000000-AddAccountLabel';

/**
 * Single source of truth for the TypeORM DataSource options, shared by the Nest
 * TypeOrmModule (runtime) and the TypeORM CLI (migration generation).
 *
 * Invariants (safety-critical):
 * - `synchronize: false` ALWAYS — schema changes only ever happen via migrations.
 * - `migrationsRun: true` — pending migrations run (idempotently) on boot.
 *
 * Entities and migrations are referenced by class, not by filesystem glob, so the
 * same list works identically under ts-node (dev) and compiled JS (prod).
 */
export function buildDataSourceOptions(config: AppConfig): DataSourceOptions {
  return {
    type: 'postgres',
    url: config.postgres.dsn,
    entities: [
      AppMetadata,
      Currency,
      Customer,
      Account,
      ExternalPayee,
      Transaction,
      LedgerEntry,
      Hold,
      UserLimits,
      OutboxEvent,
      AuditLog,
      ApprovalRequest,
      IdempotencyKey,
    ],
    migrations: [
      CreateAppMetadata1725000000000,
      CreateBalanceCore1788825600000,
      CreateBalanceSatellites1788912000000,
      SeedSystemAccounts1788998400000,
      CreateCustomerAndAccountNumber1789084800000,
      AddTransactionLifecycle1789171200000,
      SeedBaselineUserLimits1789257600000,
      AddAccountLabel1789344000000,
    ],
    migrationsRun: true,
    synchronize: false,
    logging: config.nodeEnv === 'development' ? ['error', 'warn', 'migration'] : ['error'],
  };
}
