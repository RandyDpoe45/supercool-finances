import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { GatewayIdentityGuard } from './common/identity/gateway-identity.guard';
import { ServiceIdentityGuard } from './common/identity/service-identity.guard';
import { requestIdMiddleware } from './common/request-context/request-id.middleware';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { ApiModule } from './modules/api/api.module';
import { IdempotencyModule } from './modules/idempotency/idempotency.module';
import { InternalModule } from './modules/internal/internal.module';
import { OtpModule } from './modules/otp/otp.module';
import { PostingModule } from './modules/posting/posting.module';
import { RedisModule } from './redis/redis.module';

/**
 * Root module. It composes the app from the three per-surface registry modules
 * ({@link ApiModule} `/api`, {@link AdminModule} `/admin`, {@link InternalModule}
 * `/internal`) plus infrastructure (config, database, redis, health) — the controller-surface
 * convention (see CLAUDE.md § Controller surfaces). Feature modules (e.g. accounts) are NOT
 * imported here directly: they are reached through the surface module that declares their
 * controllers (accounts via {@link ApiModule}), which exports nothing to AppModule.
 *
 * The identity guards and the error filter are bound GLOBALLY (APP_GUARD / APP_FILTER) so no
 * endpoint can skip them — each guard scopes itself to its own prefix (`/api`+`/admin` vs
 * `/internal`). Order matters only in that both guards run for every request; each returns
 * early for foreign prefixes.
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
    // PostingModule, IdempotencyModule and OtpModule are SERVICE-ONLY feature modules (no
    // controller yet). They are imported here transitionally so their services are resolvable
    // in the graph; each moves under its consuming surface module once a controller uses it
    // (the transfers `-api` controller, step 4b).
    PostingModule,
    IdempotencyModule,
    OtpModule,
    AdminModule,
    InternalModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: GatewayIdentityGuard },
    { provide: APP_GUARD, useClass: ServiceIdentityGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestIdMiddleware).forRoutes('*');
  }
}
