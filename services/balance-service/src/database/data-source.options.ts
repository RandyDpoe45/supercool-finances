import { DataSourceOptions } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { AppMetadata } from './entities/app-metadata.entity';
import { Currency } from './entities/currency.entity';
import { Account } from './entities/account.entity';
import { ExternalPayee } from './entities/external-payee.entity';
import { Transaction } from './entities/transaction.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { CreateAppMetadata1725000000000 } from './migrations/1725000000000-CreateAppMetadata';
import { CreateBalanceCore1788825600000 } from './migrations/1788825600000-CreateBalanceCore';

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
    entities: [AppMetadata, Currency, Account, ExternalPayee, Transaction, LedgerEntry],
    migrations: [CreateAppMetadata1725000000000, CreateBalanceCore1788825600000],
    migrationsRun: true,
    synchronize: false,
    logging: config.nodeEnv === 'development' ? ['error', 'warn', 'migration'] : ['error'],
  };
}
