import { z } from 'zod';

/**
 * Wire-validation schema for the admin `PUT /admin/limits` body, applied by the reusable
 * {@link ZodValidationPipe} at the controller boundary. It enforces the SHAPE of the input (a
 * security control against param mishandling / injection); the service re-checks the business
 * invariant it owns (global ⇒ no ownerId; customer ⇒ ownerId required → `InvalidLimitsError`).
 * Caps are unsigned minor-unit digit strings (never a JS number — int64 precision) or `null`
 * (uncapped). `.strict()` rejects unknown keys (defense-in-depth against param smuggling).
 */

/** A cap value: an unsigned minor-unit integer string, or `null`/absent (uncapped for that field). */
const capSchema = z
  .string()
  .regex(/^\d+$/, 'cap must be an unsigned minor-unit integer string')
  .nullable()
  .optional();

export const upsertLimitsSchema = z
  .object({
    scope: z.enum(['global', 'customer']),
    // A customer `sub` (the owner id). Optional/nullable here — the service enforces the
    // presence/absence rule per scope.
    ownerId: z.string().min(1).nullable().optional(),
    currency: z.string().length(3),
    perTransactionMax: capSchema,
    dailyMax: capSchema,
    monthlyMax: capSchema,
  })
  .strict();

export type UpsertLimitsBody = z.infer<typeof upsertLimitsSchema>;
