import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Identity } from '../../common/identity/identity.decorator';
import { RequestIdentity } from '../../common/identity/request-identity';
import { AccountsService } from './accounts.service';
import { AccountDto } from './dto/account.dto';
import { StatementEntryDto } from './dto/statement-entry.dto';

/**
 * Customer-plane account reads. Under the global `/api` prefix, so the
 * {@link GatewayIdentityGuard} has already required the Kong `X-User-Id` and populated
 * the identity — the caller id is taken from `@Identity()`, never the body/query.
 */
@Controller('api')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('accounts')
  listAccounts(@Identity() identity: RequestIdentity): Promise<{ accounts: AccountDto[] }> {
    return this.accounts.listOwnedAccounts(identity.userId);
  }

  @Get('accounts/:id/transactions')
  getAccountTransactions(
    // ParseUUIDPipe rejects a malformed id with 400 before any DB access.
    @Param('id', ParseUUIDPipe) id: string,
    @Identity() identity: RequestIdentity,
  ): Promise<{ accountId: string; entries: StatementEntryDto[] }> {
    return this.accounts.getAccountStatement(id, identity.userId);
  }
}
