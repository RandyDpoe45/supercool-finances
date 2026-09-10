import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AccountsAdminController } from '../accounts/admin/accounts-admin.controller';
import { AuditModule } from '../audit/audit.module';
import { LimitsModule } from '../limits/limits.module';
import { LimitsAdminController } from '../limits/admin/limits-admin.controller';
import { RailsModule } from '../rails/rails.module';
import { RailsAdminController } from '../rails/admin/rails-admin.controller';
import { TransfersModule } from '../transfers/transfers.module';
import { TransfersAdminController } from '../transfers/admin/transfers-admin.controller';
import { AdminController } from './admin.controller';

/**
 * The `/admin` SURFACE registry (admin plane, role-gated by the {@link GatewayIdentityGuard} —
 * `X-User-Id` + the `admin` role, else 403). It DECLARES every `/admin` controller and imports the
 * feature modules for the services those controllers inject — the controller-surface convention
 * (see CLAUDE.md § Controller surfaces):
 * - `AdminController` — the foundation `whoami` guard probe (spec 03), kept.
 * - `AccountsAdminController` — single-actor freeze/unfreeze, injecting `ACCOUNTS_SERVICE`
 *   ({@link AccountsModule}).
 * - `LimitsAdminController` — single-actor `PUT /limits`, injecting `LIMITS_SERVICE`
 *   ({@link LimitsModule}).
 * - `TransfersAdminController` — `GET /transactions` (view ANY transaction, a read, no audit),
 *   injecting `TRANSFERS_SERVICE` ({@link TransfersModule}) — its `listTransactions` read is
 *   deliberately NOT owner-scoped.
 * - `RailsAdminController` — trigger a simulated external inbound, injecting `RAILS_SERVICE`
 *   ({@link RailsModule}) and `AUDIT_SERVICE` ({@link AuditModule}).
 *
 * {@link AuditModule} is imported directly so `RailsAdminController` can inject `AUDIT_SERVICE`
 * (the accounts/limits services import it themselves for their in-tx audit). This step is the
 * SINGLE-ACTOR admin ops + the audit foundation; maker-checker (reversals + approvals) is step 8b.
 */
@Module({
  imports: [AuditModule, AccountsModule, LimitsModule, TransfersModule, RailsModule],
  controllers: [
    AdminController,
    AccountsAdminController,
    LimitsAdminController,
    TransfersAdminController,
    RailsAdminController,
  ],
})
export class AdminModule {}
