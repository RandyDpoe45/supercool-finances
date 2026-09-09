import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { IdempotencyService } from './idempotency.service';

/**
 * The idempotency domain module. Provides {@link IdempotencyService} — the generic
 * at-most-once + soft-duplicate wrapper money-moving requests run through (spec 04 Transfers).
 * Imports {@link PersistenceModule} for the `IDEMPOTENCY_KEY_REPOSITORY` token; the app-wide
 * `DataSource` is injected via `@InjectDataSource()`. Exported so the transfers surface module
 * (step 4) can depend on it. No controller — this step has no HTTP surface.
 */
@Module({
  imports: [PersistenceModule],
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
