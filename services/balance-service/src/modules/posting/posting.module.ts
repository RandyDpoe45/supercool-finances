import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { PostingService } from './service/impl/posting.service';
import { POSTING_SERVICE } from './service/interfaces/posting.service.interface';

/**
 * The posting domain module. Provides the single balance-mutating reducer all money movement
 * funnels through (ADR-13), bound behind the `POSTING_SERVICE` token (interface/impl split —
 * consumers depend on `IPostingService`, never the concrete class). Imports
 * {@link PersistenceModule} for the repository interface tokens; the app-wide `DataSource`
 * (wired by `DatabaseModule`) is injected via `@InjectDataSource()` to open the reducer's
 * QueryRunner. Exported so the later transfers / holds / admin modules can depend on it. No
 * controller — this step has no HTTP surface.
 */
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: POSTING_SERVICE, useClass: PostingService }],
  exports: [POSTING_SERVICE],
})
export class PostingModule {}
