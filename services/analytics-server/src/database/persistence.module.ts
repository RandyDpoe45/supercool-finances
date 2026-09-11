import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { ReportingRepository } from './repositories/impl/reporting.repository';
import { TransactionsRepository } from './repositories/impl/transactions.repository';
import { REPORTING_REPOSITORY } from './repositories/interfaces/reporting.repository.interface';
import { TRANSACTIONS_REPOSITORY } from './repositories/interfaces/transactions.repository.interface';
import { TRANSACTION_MODEL_NAME, TransactionSchema } from './schemas/transaction.schema';

/**
 * Binds the read-model repository interfaces (tokens) to their Mongoose implementations
 * and exports the tokens, so spec 05's consumer + reporting modules inject the
 * interface — never the concrete class. `MongooseModule.forFeature` registers the
 * `transactions` model (and its indexes) against the root connection wired by
 * {@link DatabaseModule} (no second connection). Both repositories share that one model:
 * `TRANSACTIONS_REPOSITORY` (idempotent upsert / read, A1/A2) and `REPORTING_REPOSITORY`
 * (query-time aggregation VIEWs, A3).
 *
 * Wired transitionally into {@link AppModule} so the schema/indexes register and the
 * app boots; the A2 consumer and A3 reporting modules import it directly.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: TRANSACTION_MODEL_NAME, schema: TransactionSchema }]),
  ],
  providers: [
    { provide: TRANSACTIONS_REPOSITORY, useClass: TransactionsRepository },
    { provide: REPORTING_REPOSITORY, useClass: ReportingRepository },
  ],
  exports: [TRANSACTIONS_REPOSITORY, REPORTING_REPOSITORY],
})
export class PersistenceModule {}
