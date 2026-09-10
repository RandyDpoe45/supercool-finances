import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import {
  ITransfersService,
  TRANSFERS_SERVICE,
} from '../service/interfaces/transfers.service.interface';
import { AdminTransactionDto } from './dto/admin-transaction.dto';
import {
  ListTransactionsQueryParams,
  listTransactionsQuerySchema,
} from './dto/transactions-query.schema';
import { serializeAdminTransaction } from './serializers/admin-transaction.serializer';

/**
 * The transfers feature's `/admin` surface controller (spec 04 "Admin ops" — `GET /transactions`,
 * view ANY transaction). DECLARED by {@link AdminModule}; the {@link TransfersModule} feature
 * module provides + exports the service behind the `TRANSFERS_SERVICE` token, injected here as
 * `ITransfersService`. Its `listTransactions` read is DELIBERATELY NOT owner-scoped (the role-gated
 * admin surface may see any owner's transactions), distinct from every owner-scoped `/api` read.
 *
 * Under the global `/admin` prefix, role-gated by the {@link GatewayIdentityGuard} (`X-User-Id` +
 * `admin` role, else 403). The query string is validated by the {@link ZodValidationPipe}
 * (`.strict()`, malformed → 400). This is a READ — it writes NO audit row. The result is a
 * NON-owner-scoped list (any transaction), serialized to the admin DTO at this boundary.
 */
@Controller('admin/transactions')
export class TransfersAdminController {
  constructor(@Inject(TRANSFERS_SERVICE) private readonly transfers: ITransfersService) {}

  /** List transactions with optional filters (ownerId / accountId / status / type) + paging
   * (limit clamped to ≤200, default 50; offset ≥0). 200, `{ transactions: AdminTransactionDto[] }`. */
  @Get()
  async listTransactions(
    @Query(new ZodValidationPipe(listTransactionsQuerySchema)) query: ListTransactionsQueryParams,
  ): Promise<{ transactions: AdminTransactionDto[] }> {
    const transactions = await this.transfers.listTransactions({
      ownerId: query.ownerId,
      accountId: query.accountId,
      status: query.status,
      type: query.type,
      limit: query.limit,
      offset: query.offset,
    });
    return { transactions: transactions.map(serializeAdminTransaction) };
  }
}
