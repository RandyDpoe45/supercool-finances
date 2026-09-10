import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { AuditModule } from '../audit/audit.module';
import { PostingModule } from '../posting/posting.module';
import { ApprovalService } from './service/impl/approval.service';
import { APPROVAL_SERVICE } from './service/interfaces/approval.service.interface';

/**
 * The approvals FEATURE module (spec 04 "Admin ops", step 8b — maker-checker reversals). It owns
 * the approval domain service and its `/admin` surface controller FILES
 * (`admin/reversals-admin.controller.ts`, `admin/approvals-admin.controller.ts`), but declares no
 * controllers of its own: per the controller-surface convention the `/admin` surface registry
 * ({@link AdminModule}) DECLARES those controllers, and this module provides + **exports** the
 * service behind the `APPROVAL_SERVICE` token (interface/impl split — consumers depend on
 * `IApprovalService`, never the concrete class).
 *
 * It imports the collaborators the service injects by token: {@link PersistenceModule}
 * (`APPROVAL_REQUEST_REPOSITORY`, `TRANSACTION_REPOSITORY`, `ACCOUNT_REPOSITORY`),
 * {@link PostingModule} (`POSTING_SERVICE` — the single balance/ledger/outbox keystone the FORCED
 * compensating movement funnels through), and {@link AuditModule} (`AUDIT_SERVICE` — the propose /
 * execute / reject audit rows). The app-wide `DataSource` is injected via `@InjectDataSource()`.
 */
@Module({
  imports: [PersistenceModule, PostingModule, AuditModule],
  providers: [{ provide: APPROVAL_SERVICE, useClass: ApprovalService }],
  exports: [APPROVAL_SERVICE],
})
export class ApprovalsModule {}
