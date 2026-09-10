import { UserLimits } from '../../../../database/entities/user-limits.entity';

/** DI token for {@link ILimitsService}. Consumers (the `/admin` surface controller) depend on the
 * interface via this token, never the concrete class. */
export const LIMITS_SERVICE = Symbol('LIMITS_SERVICE');

/**
 * Inputs to {@link ILimitsService.upsertLimits} — the admin `PUT /limits` body. `scope` selects the
 * GLOBAL baseline or a per-CUSTOMER override; for `global` the `ownerId` MUST be null/absent, for
 * `customer` it is REQUIRED (validated in the service). Each cap is a canonical minor-unit string
 * or `null`/absent (uncapped for that field). `actorId` is supplied separately (the trusted gateway
 * identity), never in this body.
 */
export interface UpsertLimitsInput {
  scope: 'global' | 'customer';
  ownerId?: string | null;
  currency: string;
  perTransactionMax?: string | null;
  dailyMax?: string | null;
  monthlyMax?: string | null;
}

/**
 * Admin limits configuration (spec 04 "Admin ops" — `PUT /limits`, a single-actor action). Upserts
 * the global baseline or a per-customer override and writes ONE audit row (before/after image) in
 * the SAME transaction as the upsert. Returns the resulting {@link UserLimits} entity — DTO
 * serialization is a transport concern applied at the controller boundary.
 */
export interface ILimitsService {
  /**
   * Validate and upsert the limits row for the given scope, auditing the change. Throws
   * `InvalidLimitsError` (→ 400) when the scope/ownerId invariant is violated (global ⇒ ownerId
   * absent; customer ⇒ ownerId present). `actorId` is the admin's trusted gateway identity.
   */
  upsertLimits(actorId: string, input: UpsertLimitsInput): Promise<UserLimits>;
}
