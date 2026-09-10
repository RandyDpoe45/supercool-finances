/**
 * Admin-plane view of a {@link UserLimits} row returned by `PUT /admin/limits`. Caps are canonical
 * `bigint` minor-unit strings (never floats) or `null` (uncapped). `ownerId` is `null` on the
 * global baseline row. Timestamps are ISO-8601 UTC strings. Every field is listed EXPLICITLY (the
 * serializer never spreads the entity).
 */
export interface LimitsDto {
  id: string;
  scope: string;
  ownerId: string | null;
  currency: string;
  perTransactionMax: string | null;
  dailyMax: string | null;
  monthlyMax: string | null;
  createdAt: string;
  updatedAt: string;
}
