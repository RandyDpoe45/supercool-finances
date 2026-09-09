import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { GatewayIdentityGuard } from './common/identity/gateway-identity.guard';
import { ServiceIdentityGuard } from './common/identity/service-identity.guard';
import { requestIdMiddleware } from './common/request-context/request-id.middleware';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { AdminModule } from './modules/admin/admin.module';
import { ApiModule } from './modules/api/api.module';
import { InternalModule } from './modules/internal/internal.module';
import { PostingModule } from './modules/posting/posting.module';

/**
 * Root module. The identity guards and the error filter are bound GLOBALLY
 * (APP_GUARD / APP_FILTER) so no endpoint can skip them — each guard scopes itself
 * to its own prefix (`/api`+`/admin` vs `/internal`). Order matters only in that
 * both guards run for every request; each returns early for foreign prefixes.
 *
 * The request-id correlation middleware is applied HERE (not in main.ts) so the
 * guarantee holds whenever AppModule is booted — including tests that create the
 * module without main.ts. The error DTO's `requestId` depends on it.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    HealthModule,
    ApiModule,
    AccountsModule,
    PostingModule,
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
