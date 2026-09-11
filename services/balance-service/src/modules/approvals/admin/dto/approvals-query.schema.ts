import { z } from 'zod';
import { ApprovalStatus } from '../../../../database/entities/enums';

/**
 * Wire-validation schema for the admin `GET /admin/approvals` query string, applied by the reusable
 * {@link ZodValidationPipe} at the controller boundary. It enforces the SHAPE of the untrusted query
 * params (a security control) before they reach the service. `status` is optional here — the SERVICE
 * applies the default (the PENDING queue, so the checker discovers pending reversals). There is NO
 * paging — approval rows are few. `.strict()` rejects unknown query keys.
 */
export const listApprovalsQuerySchema = z
  .object({
    status: z.nativeEnum(ApprovalStatus).optional(),
  })
  .strict();

export type ListApprovalsQueryParams = z.infer<typeof listApprovalsQuerySchema>;
