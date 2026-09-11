import { z } from 'zod';

/**
 * Wire-validation schema for the admin `GET /admin/limits` query string, applied by the reusable
 * {@link ZodValidationPipe} at the controller boundary. It enforces the SHAPE of the untrusted query
 * params (a security control) before they reach the service. Both filters are optional (absent → all
 * limits rows). There is NO paging — limits rows are few (one global baseline plus per-customer
 * overrides), so the read is naturally bounded. `.strict()` rejects unknown query keys.
 */
export const listLimitsQuerySchema = z
  .object({
    scope: z.enum(['global', 'customer']).optional(),
    ownerId: z.string().min(1).optional(),
  })
  .strict();

export type ListLimitsQueryParams = z.infer<typeof listLimitsQuerySchema>;
