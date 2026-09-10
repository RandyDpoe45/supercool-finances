import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { RelayService } from './service/impl/relay.service';
import { RELAY_SERVICE } from './service/interfaces/relay.service.interface';

/**
 * The outbox relay FEATURE module (spec 04 step 6). Provides + exports the in-process relay
 * worker behind the `RELAY_SERVICE` token (interface/impl split — consumers depend on
 * `IRelayService`, never the concrete class). It has **no controller** (service-only): the loop
 * runs itself off `OnApplicationBootstrap`, and `drainOnce()` is the seam the tests drive.
 *
 * Imports `PersistenceModule` for `OUTBOX_EVENT_REPOSITORY`; the `REDIS_CLIENT`, `DataSource`,
 * and `APP_CONFIG` the service injects all come from `@Global` / root modules, so they are NOT
 * imported here. Being service-only with no consuming surface, it is imported **transitionally
 * by `AppModule`** (like the former `OtpModule` / `IdempotencyModule`) so the loop runs in the
 * real service.
 */
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: RELAY_SERVICE, useClass: RelayService }],
  exports: [RELAY_SERVICE],
})
export class RelayModule {}
