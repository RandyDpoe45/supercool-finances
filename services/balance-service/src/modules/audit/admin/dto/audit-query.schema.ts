import { z } from 'zod';

/**
 * Wire-validation schema for the admin `GET /admin/audit` query string, applied by the reusable
 * {@link ZodValidationPipe} at the controller boundary. It enforces the SHAPE of the untrusted query
 * params (a security control) before they reach the service. `actorId` / `action` / `targetType` /
 * `targetId` are exact-match string filters (each non-empty when present); `limit` / `offset` are
 * coerced to non-negative integers (query params arrive as strings) and left UNBOUNDED here — the
 * service CLAMPS them (default 50, max 200), so an over-large request is clamped, not rejected.
 * `.strict()` rejects unknown query keys.
 */
export const listAuditQuerySchema = z
  .object({
    actorId: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    targetType: z.string().min(1).optional(),
    targetId: z.string().min(1).optional(),
    limit: z.coerce.number().int().nonnegative().optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export type ListAuditQueryParams = z.infer<typeof listAuditQuerySchema>;
