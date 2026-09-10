import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { AuditService } from './service/impl/audit.service';
import { AUDIT_SERVICE } from './service/interfaces/audit.service.interface';

/**
 * The audit FEATURE module (spec 04 "Admin ops" — every mutating admin action writes the audit
 * log). A cross-cutting, service-only module: it binds the audit writer behind the `AUDIT_SERVICE`
 * token (interface/impl split — consumers depend on `IAuditService`, never the concrete class) and
 * **exports** it. It has NO controller of its own.
 *
 * Imported by every feature module whose admin ops audit ({@link AccountsModule},
 * {@link LimitsModule}) and by the `/admin` surface registry ({@link AdminModule}) for the
 * controllers that record directly (the simulated inbound). Importing {@link PersistenceModule}
 * wires the `AUDIT_LOG_REPOSITORY` token the service depends on.
 */
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: AUDIT_SERVICE, useClass: AuditService }],
  exports: [AUDIT_SERVICE],
})
export class AuditModule {}
