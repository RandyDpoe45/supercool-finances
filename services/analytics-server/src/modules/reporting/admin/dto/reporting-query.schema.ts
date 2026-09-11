import { z } from 'zod';

/**
 * Wire-validation schemas for the admin `GET /admin/reports/*` query strings, applied by
 * the reusable {@link ZodValidationPipe} at the controller boundary. They enforce the
 * SHAPE of the untrusted query params (a security control) before they reach the service.
 * `limit` / `offset` are coerced to non-negative integers (query params arrive as strings)
 * and left UNBOUNDED here — the service CLAMPS them (default 50, max 200), so an over-large
 * request is clamped, not rejected. `from` / `to` are coerced to dates. `.strict()` rejects
 * unknown query keys.
 */
export const accountSummariesQuerySchema = z
  .object({
    ownerId: z.string().min(1).optional(),
    accountId: z.string().uuid().optional(),
    currency: z.string().min(1).optional(),
    limit: z.coerce.number().int().nonnegative().optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export type AccountSummariesQueryParams = z.infer<typeof accountSummariesQuerySchema>;

export const dailyAggregatesQuerySchema = z
  .object({
    currency: z.string().min(1).optional(),
    type: z.enum(['internal', 'external_outbound', 'external_inbound']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().nonnegative().optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export type DailyAggregatesQueryParams = z.infer<typeof dailyAggregatesQuerySchema>;
