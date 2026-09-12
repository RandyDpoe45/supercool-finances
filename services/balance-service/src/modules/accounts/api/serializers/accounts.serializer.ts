import { availableBalance } from '../../../../common/money/money';
import { Account } from '../../../../database/entities/account.entity';
import { LedgerEntry } from '../../../../database/entities/ledger-entry.entity';
import { AccountDto } from '../dto/account.dto';
import { StatementEntryDto } from '../dto/statement-entry.dto';

/**
 * The anti-leak transport boundary: pure entity→DTO serializers for the `/api/accounts`
 * reads. Each lists its output fields EXPLICITLY and MUST NOT spread the entity — internal
 * columns (`ownerId`, `systemKey`, `spentToday`/`spentMonth` + their dates,
 * `createdAt`/`updatedAt`, …) must never reach the wire. Adding a field to a DTO is a
 * deliberate act here, not an accident of object shape.
 */

/** `available` is derived at serialize time (`balance − held`), never read from storage. */
export function serializeAccount(account: Account): AccountDto {
  return {
    id: account.id,
    currency: account.currency,
    status: account.status,
    kind: account.kind,
    balance: account.balance,
    held: account.held,
    available: availableBalance(account.balance, account.held),
    accountNumber: account.accountNumber,
    label: account.label,
  };
}

/** `createdAt` is rendered as an ISO-8601 UTC instant. */
export function serializeStatementEntry(entry: LedgerEntry): StatementEntryDto {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    delta: entry.delta,
    balanceAfter: entry.balanceAfter,
    currency: entry.currency,
    createdAt: entry.createdAt.toISOString(),
  };
}
