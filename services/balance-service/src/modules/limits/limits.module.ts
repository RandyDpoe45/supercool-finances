import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { AuditModule } from '../audit/audit.module';
import { LimitsService } from './service/impl/limits.service';
import { LIMITS_SERVICE } from './service/interfaces/limits.service.interface';

/**
 * The limits FEATURE module (spec 04 "Admin ops" — the `PUT /limits` configuration surface). It
 * owns the limits domain service and its `/admin` surface controller FILE
 * (`admin/limits-admin.controller.ts`), but declares no controllers of its own: per the
 * controller-surface convention the `/admin` surface registry ({@link AdminModule}) DECLARES
 * `LimitsAdminController`, and this module provides + **exports** the service behind the
 * `LIMITS_SERVICE` token (interface/impl split — consumers depend on `ILimitsService`, never the
 * concrete class).
 *
 * It imports {@link PersistenceModule} for the `USER_LIMITS_REPOSITORY` token and {@link AuditModule}
 * for the `AUDIT_SERVICE` the upsert writes its audit row through. The app-wide `DataSource` is
 * injected via `@InjectDataSource()`.
 */
@Module({
  imports: [PersistenceModule, AuditModule],
  providers: [{ provide: LIMITS_SERVICE, useClass: LimitsService }],
  exports: [LIMITS_SERVICE],
})
export class LimitsModule {}
