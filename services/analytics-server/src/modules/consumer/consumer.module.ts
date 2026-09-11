import { Module } from '@nestjs/common';
import { PersistenceModule } from '../../database/persistence.module';
import { StreamConsumerService } from './service/impl/stream-consumer.service';
import { STREAM_CONSUMER_SERVICE } from './service/interfaces/stream-consumer.service.interface';

/**
 * The transaction-stream consumer FEATURE module (spec 05, step A2). Provides + exports the
 * in-process consumer behind the `STREAM_CONSUMER_SERVICE` token (interface/impl split —
 * consumers depend on `IStreamConsumerService`, never the concrete class). It has **no
 * controller** (service-only): the loop runs itself off `OnApplicationBootstrap`, and
 * `consumeOnce()` is the seam the tests drive.
 *
 * Imports `PersistenceModule` for `TRANSACTIONS_REPOSITORY`; the `REDIS_CLIENT` and `APP_CONFIG`
 * the service injects come from the `@Global` `RedisModule` / `AppConfigModule`, so they are NOT
 * imported here. Being service-only with no consuming surface, it is imported **transitionally
 * by `AppModule`** (like the balance service's `RelayModule`) so the loop runs in the real service.
 */
@Module({
  imports: [PersistenceModule],
  providers: [{ provide: STREAM_CONSUMER_SERVICE, useClass: StreamConsumerService }],
  exports: [STREAM_CONSUMER_SERVICE],
})
export class ConsumerModule {}
