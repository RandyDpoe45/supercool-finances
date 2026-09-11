import { z } from 'zod';

/**
 * Wire-validation schema for the admin `GET /admin/accounts` query string, applied by the reusable
 * {@link ZodValidationPipe} at the controller boundary. It enforces the SHAPE of the untrusted query
 * params (a security control) before they reach the service. `limit` / `offset` are coerced to
 * non-negative integers (query params arrive as strings) and left UNBOUNDED here — the service
 * CLAMPS them (default 50, max 200), so an over-large request is clamped, not rejected. `.strict()`
 * rejects unknown query keys.
 */
export const listAccountsQuerySchema = z
  .object({
    ownerId: z.string().min(1).optional(),
    limit: z.coerce.number().int().nonnegative().optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export type ListAccountsQueryParams = z.infer<typeof listAccountsQuerySchema>;
