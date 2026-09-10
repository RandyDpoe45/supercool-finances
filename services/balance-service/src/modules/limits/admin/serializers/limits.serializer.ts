import { UserLimits } from '../../../../database/entities/user-limits.entity';
import { LimitsDto } from '../dto/limits.dto';

/**
 * The anti-leak transport boundary for the `/admin/limits` response: an explicit whitelist that
 * lists every output field by hand and MUST NOT spread the entity. Adding a field is a deliberate
 * act. Timestamps render as ISO-8601 UTC instants.
 */
export function serializeLimits(row: UserLimits): LimitsDto {
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.ownerId,
    currency: row.currency,
    perTransactionMax: row.perTransactionMax,
    dailyMax: row.dailyMax,
    monthlyMax: row.monthlyMax,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
