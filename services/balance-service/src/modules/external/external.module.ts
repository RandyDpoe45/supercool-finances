import { Module } from '@nestjs/common';
import { RailsExternalController } from '../rails/external/rails-external.controller';
import { RailsModule } from '../rails/rails.module';

/**
 * The `/external` SURFACE registry (third-party rail plane, spec 04 step 5c). It DECLARES every
 * `/external` controller and imports the feature modules for the services those controllers
 * inject — the controller-surface convention (see CLAUDE.md § Controller surfaces):
 * - `RailsExternalController` — the outbound settlement callback + inbound credit webhooks,
 *   injecting `RAILS_SERVICE` ({@link RailsModule}).
 *
 * `/external` is a DISTINCT trust domain from `/api` (customers) and `/internal` (our own peers):
 * it is guarded globally by `ExternalApiKeyGuard` (bound in {@link AppModule}), which requires the
 * rail's `X-Api-Key`. This module carries no guard of its own (the guard is prefix-scoped + global).
 */
@Module({
  imports: [RailsModule],
  controllers: [RailsExternalController],
})
export class ExternalModule {}
