import { z } from 'zod';

/**
 * Wire-validation schema for `POST /admin/transfers/:id/reverse`, applied by the reusable
 * {@link ZodValidationPipe} at the controller boundary. The body is OPTIONAL context — a free-form
 * `reason` recorded on the proposal's payload. `.strict()` rejects unknown keys (defense-in-depth
 * against param smuggling). The reversal TARGET is the path `:id` (a uuid), never the body.
 */
export const proposeReversalSchema = z.preprocess(
  // The body is entirely optional; an absent body (undefined/null) is normalized to {} so a
  // reverse with no reason still validates. A present body with unknown keys still fails `.strict()`.
  (value) => value ?? {},
  z
    .object({
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
);
export type ProposeReversalBody = z.infer<typeof proposeReversalSchema>;
