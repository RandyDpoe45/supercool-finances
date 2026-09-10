import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Identity } from '../../../common/identity/identity.decorator';
import { RequestIdentity } from '../../../common/identity/request-identity';
import {
  ACCOUNTS_SERVICE,
  IAccountsService,
} from '../service/interfaces/accounts.service.interface';
import { AdminAccountDto } from './dto/admin-account.dto';
import { serializeAdminAccount } from './serializers/accounts-admin.serializer';

/**
 * The accounts feature's `/admin` surface controller (spec 04 "Admin ops" — single-actor
 * freeze/unfreeze). DECLARED by {@link AdminModule} (the `/admin` surface registry); the
 * {@link AccountsModule} feature module provides + exports the service behind the
 * `ACCOUNTS_SERVICE` token, injected here as `IAccountsService`.
 *
 * Under the global `/admin` prefix, the {@link GatewayIdentityGuard} has already required the
 * Kong `X-User-Id` AND the `admin` role (else 403). The actor id is read ONLY via `@Identity()`
 * (`identity.userId`) — never the body/query — and recorded as the audit `actorId`. The service
 * returns entities; this controller serializes them to an admin DTO at the boundary. Each op is a
 * single-actor action (maker-checker is reversals-only, step 8b) that writes ONE audit row in the
 * same transaction as the status flip.
 */
@Controller('admin/accounts')
export class AccountsAdminController {
  constructor(@Inject(ACCOUNTS_SERVICE) private readonly accounts: IAccountsService) {}

  /** Freeze a customer account (blocks its future debits; credits still land). 200, admin view. */
  @Post(':id/freeze')
  @HttpCode(HttpStatus.OK)
  async freeze(
    @Param('id', ParseUUIDPipe) id: string,
    @Identity() identity: RequestIdentity,
  ): Promise<AdminAccountDto> {
    const account = await this.accounts.setFrozen(identity.userId, id, true);
    return serializeAdminAccount(account);
  }

  /** Unfreeze a customer account (restores its debits). 200, admin view. */
  @Post(':id/unfreeze')
  @HttpCode(HttpStatus.OK)
  async unfreeze(
    @Param('id', ParseUUIDPipe) id: string,
    @Identity() identity: RequestIdentity,
  ): Promise<AdminAccountDto> {
    const account = await this.accounts.setFrozen(identity.userId, id, false);
    return serializeAdminAccount(account);
  }
}
