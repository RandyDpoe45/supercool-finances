import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { ReportingAdminController } from './admin/reporting-admin.controller';
import { ReportingService } from './service/impl/reporting.service';
import { REPORTING_SERVICE } from './service/interfaces/reporting.service.interface';

/**
 * The reporting FEATURE module (spec 05, step A3) — the `/admin` dashboard aggregates over
 * the Mongo read model. It owns + declares its own `/admin` surface controller
 * (`admin/reporting-admin.controller.ts`) and provides the reporting service behind the
 * `REPORTING_SERVICE` token (interface/impl split — consumers depend on `IReportingService`,
 * never the concrete class).
 *
 * Imports {@link PersistenceModule} for the `REPORTING_REPOSITORY` the service injects (the
 * `Transaction` model is registered there via `forFeature`). Imported directly by
 * {@link AppModule}; the global gateway guard role-gates the `/admin` routes.
 */
@Module({
  imports: [PersistenceModule],
  controllers: [ReportingAdminController],
  providers: [{ provide: REPORTING_SERVICE, useClass: ReportingService }],
})
export class ReportingModule {}
