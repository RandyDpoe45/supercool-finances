import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { PayeesService } from './service/impl/payees.service';
import { PAYEES_SERVICE } from './service/interfaces/payees.service.interface';

/**
 * The payees FEATURE module (spec 04 "External payees", step 5 — enrollment). It owns the payees
 * domain service and its `/api` surface controller FILE (`api/payees-api.controller.ts`), but
 * declares no controllers of its own: per the controller-surface convention the `/api` surface
 * registry ({@link ApiModule}) DECLARES `PayeesApiController`, and this module provides + **exports**
 * the service behind the `PAYEES_SERVICE` token (interface/impl split — consumers depend on
 * `IPayeesService`, never the concrete class).
 *
 * It imports {@link PersistenceModule} for the `EXTERNAL_PAYEE_REPOSITORY` interface token the
 * service injects. The other injected token, `APP_CONFIG` (the cooling-off window), comes from the
 * `@Global` config module, so it is NOT imported here (same as {@link OtpModule}).
 */
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: PAYEES_SERVICE, useClass: PayeesService }],
  exports: [PAYEES_SERVICE],
})
export class PayeesModule {}
