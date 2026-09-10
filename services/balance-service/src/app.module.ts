import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { GatewayIdentityGuard } from './common/identity/gateway-identity.guard';
import { RailSignatureGuard } from './common/identity/rail-signature.guard';
import { ServiceIdentityGuard } from './common/identity/service-identity.guard';
import { requestIdMiddleware } from './common/request-context/request-id.middleware';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { ApiModule } from './modules/api/api.module';
import { ExternalModule } from './modules/external/external.module';
import { InternalModule } from './modules/internal/internal.module';
import { RelayModule } from './modules/relay/relay.module';
import { RedisModule } from './redis/redis.module';

/**
 * Root module. It composes the app from the three per-surface registry modules
 * ({@link ApiModule} `/api`, {@link AdminModule} `/admin`, {@link InternalModule}
 * `/internal`) plus infrastructure (config, database, redis, health) — the controller-surface
 * convention (see CLAUDE.md § Controller surfaces). Feature modules (accounts, transfers, otp)
 * are NOT imported here directly: they are reached through the surface module that declares
 * their controllers. Since `TransfersApiController` and `OtpApiController` now consume them,
 * `TransfersModule` (which imports `PostingModule` + `IdempotencyModule` + `OtpModule`) and
 * `OtpModule` are reached via {@link ApiModule} — so the former transitional `PostingModule` /
 * `IdempotencyModule` / `OtpModule` imports here have been removed.
 *
 * {@link RelayModule} (the outbox relay worker) IS imported here transitionally: it is a
 * service-only module with no controller, so nothing else pulls it into the graph — importing it
 * here is what makes the in-process poll loop run in the real service (`RELAY_ENABLED` gates it).
 *
 * The identity guards and the error filter are bound GLOBALLY (APP_GUARD / APP_FILTER) so no
 * endpoint can skip them — each guard scopes itself to its own prefix (`/api`+`/admin` vs
 * `/internal` vs `/external`, three distinct trust domains). Order matters only in that all
 * guards run for every request; each returns early for foreign prefixes.
 *
 * The request-id correlation middleware is applied HERE (not in main.ts) so the guarantee
 * holds whenever AppModule is booted — including tests that create the module without
 * main.ts. The error DTO's `requestId` depends on it.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    // RedisModule is @Global: imported ONCE here so the REDIS_CLIENT token is resolvable
    // everywhere (the OTP service now, the step-6 outbox relay later).
    RedisModule,
    HealthModule,
    ApiModule,
    AdminModule,
    InternalModule,
    ExternalModule,
    // Transitional: service-only, no controller — imported here so the poll loop runs.
    RelayModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: GatewayIdentityGuard },
    { provide: APP_GUARD, useClass: ServiceIdentityGuard },
    { provide: APP_GUARD, useClass: RailSignatureGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestIdMiddleware).forRoutes('*');
  }
}
