import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Identity } from '../../common/identity/identity.decorator';
import { RequestIdentity } from '../../common/identity/request-identity';
import { serializeAccount, serializeStatementEntry } from './accounts.serializer';
import { AccountsService } from './accounts.service';
import { AccountDto } from './dto/account.dto';
import { StatementEntryDto } from './dto/statement-entry.dto';

/**
 * Customer-plane account reads — the accounts feature's `/api` surface controller. It is
 * DECLARED by {@link ApiModule} (the `/api` surface registry), while the {@link
 * AccountsModule} feature module provides + exports the {@link AccountsService} it injects.
 *
 * Under the global `/api` prefix, so the {@link GatewayIdentityGuard} has already required
 * the Kong `X-User-Id` and populated the identity — the caller id is taken from
 * `@Identity()`, never the body/query. The service returns entities; the controller
 * serializes them to DTOs at this boundary so no raw entity ever reaches the wire.
 */
@Controller('api')
export class AccountsApiController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('accounts')
  async listAccounts(@Identity() identity: RequestIdentity): Promise<{ accounts: AccountDto[] }> {
    const accounts = await this.accounts.listOwnedAccounts(identity.userId);
    return { accounts: accounts.map(serializeAccount) };
  }

  @Get('accounts/:id/transactions')
  async getAccountTransactions(
    // ParseUUIDPipe rejects a malformed id with 400 before any DB access.
    @Param('id', ParseUUIDPipe) id: string,
    @Identity() identity: RequestIdentity,
  ): Promise<{ accountId: string; entries: StatementEntryDto[] }> {
    const { account, entries } = await this.accounts.getAccountStatement(id, identity.userId);
    return { accountId: account.id, entries: entries.map(serializeStatementEntry) };
  }
}
