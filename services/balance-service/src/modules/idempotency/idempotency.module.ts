import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { IdempotencyService } from './impl/idempotency.service';
import { IDEMPOTENCY_SERVICE } from './interfaces/idempotency.service.interface';

/**
 * The idempotency domain module. Provides the generic at-most-once + soft-duplicate wrapper
 * money-moving requests run through (spec 04 Transfers), bound behind the `IDEMPOTENCY_SERVICE`
 * token (interface/impl split — consumers depend on `IIdempotencyService`, never the concrete
 * class). Imports {@link PersistenceModule} for the `IDEMPOTENCY_KEY_REPOSITORY` token; the
 * app-wide `DataSource` is injected via `@InjectDataSource()`. Exported so the transfers
 * surface module (step 4) can depend on it. No controller — this step has no HTTP surface.
 */
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: IDEMPOTENCY_SERVICE, useClass: IdempotencyService }],
  exports: [IDEMPOTENCY_SERVICE],
})
export class IdempotencyModule {}
