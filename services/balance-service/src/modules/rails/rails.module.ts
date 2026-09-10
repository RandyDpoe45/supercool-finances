import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { PostingModule } from '../posting/posting.module';
import { RailsService } from './service/impl/rails.service';
import { RAILS_SERVICE } from './service/interfaces/rails.service.interface';

/**
 * The rails FEATURE module (spec 04 "Mocked external rails", step 5c). It owns the rails domain
 * service and its `/external` surface controller FILE (`external/rails-external.controller.ts`),
 * but declares no controllers of its own: per the controller-surface convention the `/external`
 * surface registry ({@link ExternalModule}) DECLARES the controller, and this module provides +
 * **exports** the service behind the `RAILS_SERVICE` token (interface/impl split — consumers
 * depend on `IRailsService`, never the concrete class).
 *
 * It imports the collaborators the service injects by token: {@link PersistenceModule}
 * (`ACCOUNT_REPOSITORY`, `TRANSACTION_REPOSITORY`, `HOLD_REPOSITORY`), {@link PostingModule}
 * (`POSTING_SERVICE` — the single balance/ledger/outbox keystone), and {@link IdempotencyModule}
 * (`IDEMPOTENCY_SERVICE` — the inbound dedup by rail `externalRef`). The app-wide `DataSource` is
 * injected via `@InjectDataSource()`.
 */
@Module({
  imports: [PersistenceModule, PostingModule, IdempotencyModule],
  providers: [{ provide: RAILS_SERVICE, useClass: RailsService }],
  exports: [RAILS_SERVICE],
})
export class RailsModule {}
