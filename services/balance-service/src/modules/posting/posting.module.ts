import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { PostingService } from './posting.service';

/**
 * The posting domain module. Provides {@link PostingService} — the single balance-mutating
 * reducer all money movement funnels through (ADR-13). Imports {@link PersistenceModule} for
 * the repository interface tokens; the app-wide `DataSource` (wired by `DatabaseModule`) is
 * injected via `@InjectDataSource()` to open the reducer's QueryRunner. Exported so the
 * later transfers / holds / admin modules can depend on it. No controller — this step has no
 * HTTP surface.
 */
@Module({
  imports: [PersistenceModule],
  providers: [PostingService],
  exports: [PostingService],
})
export class PostingModule {}
