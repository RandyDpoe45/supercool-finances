import { availableBalance } from '../../../../common/money/money';
import { Account } from '../../../../database/entities/account.entity';
import { AdminAccountDto } from '../dto/admin-account.dto';

/**
 * The anti-leak transport boundary for the `/admin/accounts` view. Like the customer serializer it
 * lists every output field EXPLICITLY and MUST NOT spread the entity — but as an ADMIN view it
 * deliberately whitelists MORE fields (`ownerId`, the timestamps). Even so, the internal spend
 * counters and `systemKey` stay off the wire: exposing an admin field is a deliberate act, not an
 * accident of object shape.
 */
export function serializeAdminAccount(account: Account): AdminAccountDto {
  return {
    id: account.id,
    ownerId: account.ownerId,
    kind: account.kind,
    currency: account.currency,
    status: account.status,
    balance: account.balance,
    held: account.held,
    available: availableBalance(account.balance, account.held),
    accountNumber: account.accountNumber,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}
