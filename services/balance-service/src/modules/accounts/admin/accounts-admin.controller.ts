import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Identity } from '../../../common/identity/identity.decorator';
import { RequestIdentity } from '../../../common/identity/request-identity';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import {
  ACCOUNTS_SERVICE,
  IAccountsService,
} from '../service/interfaces/accounts.service.interface';
import { ListAccountsQueryParams, listAccountsQuerySchema } from './dto/accounts-query.schema';
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

  /** List accounts with an optional `ownerId` filter + paging (limit clamped to ≤200, default 50;
   * offset ≥0). A NON-owner-scoped READ (any owner, incl. system accounts) — writes NO audit row.
   * 200, `{ accounts: AdminAccountDto[] }`. */
  @Get()
  async listAccounts(
    @Query(new ZodValidationPipe(listAccountsQuerySchema)) query: ListAccountsQueryParams,
  ): Promise<{ accounts: AdminAccountDto[] }> {
    const accounts = await this.accounts.listAccounts({
      ownerId: query.ownerId,
      limit: query.limit,
      offset: query.offset,
    });
    return { accounts: accounts.map(serializeAdminAccount) };
  }

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
