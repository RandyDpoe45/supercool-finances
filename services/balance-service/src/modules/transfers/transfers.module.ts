import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { OtpModule } from '../otp/otp.module';
import { PostingModule } from '../posting/posting.module';
import { TransfersService } from './service/impl/transfers.service';
import { TRANSFERS_SERVICE } from './service/interfaces/transfers.service.interface';

/**
 * The transfers FEATURE module (spec 04 Transfers, step 4b — internal transfers). It owns the
 * transfers domain service and its `/api` surface controller FILE
 * (`api/transfers-api.controller.ts`), but declares no controllers of its own: per the
 * controller-surface convention the `/api` surface registry ({@link ApiModule}) DECLARES the
 * controller, and this module provides + **exports** the service behind the `TRANSFERS_SERVICE`
 * token (interface/impl split — consumers depend on `ITransfersService`, never the concrete
 * class).
 *
 * It imports the collaborators the service injects by token: {@link PersistenceModule}
 * (`ACCOUNT_REPOSITORY`, `TRANSACTION_REPOSITORY`), {@link PostingModule} (`POSTING_SERVICE`),
 * {@link IdempotencyModule} (`IDEMPOTENCY_SERVICE`), and {@link OtpModule} (`OTP_SERVICE`). The
 * app-wide `DataSource` is injected via `@InjectDataSource()`. These three former service-only
 * feature modules are now reached through this module (and `OtpModule` also directly by
 * `ApiModule` for its own controller), so `AppModule` no longer imports them transitionally.
 *
 * The service also owns the admin-scoped, NON-owner-scoped `listTransactions` read (spec 04 step 8a
 * — view ANY transaction), consumed by the `/admin` surface registry ({@link AdminModule}) which
 * declares `TransfersAdminController`. It reuses the already-injected `TRANSACTION_REPOSITORY` — no
 * new collaborator.
 */
@Module({
  imports: [PersistenceModule, PostingModule, IdempotencyModule, OtpModule],
  providers: [{ provide: TRANSFERS_SERVICE, useClass: TransfersService }],
  exports: [TRANSFERS_SERVICE],
})
export class TransfersModule {}
