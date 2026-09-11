import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { TransactionsRepository } from './repositories/impl/transactions.repository';
import { TRANSACTIONS_REPOSITORY } from './repositories/interfaces/transactions.repository.interface';
import { TRANSACTION_MODEL_NAME, TransactionSchema } from './schemas/transaction.schema';

/**
 * Binds the read-model repository interface (token) to its Mongoose implementation
 * and exports the token, so spec 05's consumer + reporting modules inject the
 * interface — never the concrete class. `MongooseModule.forFeature` registers the
 * `transactions` model (and its indexes) against the root connection wired by
 * {@link DatabaseModule} (no second connection).
 *
 * Wired transitionally into {@link AppModule} so the schema/indexes register and the
 * app boots; the A2 consumer and A3 reporting modules import it directly once they land.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: TRANSACTION_MODEL_NAME, schema: TransactionSchema }]),
  ],
  providers: [{ provide: TRANSACTIONS_REPOSITORY, useClass: TransactionsRepository }],
  exports: [TRANSACTIONS_REPOSITORY],
})
export class PersistenceModule {}
