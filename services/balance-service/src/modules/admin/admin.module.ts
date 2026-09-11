import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AccountsAdminController } from '../accounts/admin/accounts-admin.controller';
import { ApprovalsModule } from '../approvals/approvals.module';
import { ApprovalsAdminController } from '../approvals/admin/approvals-admin.controller';
import { ReversalsAdminController } from '../approvals/admin/reversals-admin.controller';
import { AuditModule } from '../audit/audit.module';
import { AuditAdminController } from '../audit/admin/audit-admin.controller';
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
 * - `AuditAdminController` — `GET /admin/audit` (browse the audit log — a NON-owner-scoped read,
 *   writes NO audit row, opens NO transaction), injecting `AUDIT_SERVICE` ({@link AuditModule}).
 *
 * {@link AuditModule} is imported directly so `RailsAdminController` and `AuditAdminController` can
 * inject `AUDIT_SERVICE` (the accounts/limits services import it themselves for their in-tx audit).
 * Step 8b adds the
 * maker-checker reversals: {@link ApprovalsModule} provides `APPROVAL_SERVICE` for the two
 * controllers this registry now also declares — `ReversalsAdminController` (the maker's
 * `POST /admin/transfers/:id/reverse`) and `ApprovalsAdminController` (the checker's
 * `POST /admin/approvals/:id/approve|reject`).
 */
@Module({
  imports: [
    AuditModule,
    AccountsModule,
    LimitsModule,
    TransfersModule,
    RailsModule,
    ApprovalsModule,
  ],
  controllers: [
    AdminController,
    AccountsAdminController,
    LimitsAdminController,
    TransfersAdminController,
    RailsAdminController,
    ReversalsAdminController,
    ApprovalsAdminController,
    AuditAdminController,
  ],
})
export class AdminModule {}
