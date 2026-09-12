import { z } from 'zod';

/**
 * Wire-validation schema for `POST /api/accounts` (customer self-service account creation),
 * applied by the reusable {@link ZodValidationPipe} at the controller boundary. It enforces the
 * SHAPE of untrusted input (a security control against param mishandling / injection) before it
 * reaches the domain service; the service owns the business invariants (owner scope, per-customer
 * cap, money-safety). `.strict()` rejects unknown keys (defense-in-depth against param smuggling) —
 * notably the owner id, which is taken ONLY from the trusted gateway identity, never the body.
 *
 * `label` is the customer-chosen display name: trimmed, 1–50 chars after trim, and free of control
 * characters (a stored display string, never an identifier or lookup key; not unique per owner).
 */

/** True iff the string contains any C0/C1 control character — never valid in a display label. */
function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export const createAccountSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, 'label must not be empty')
      .max(50, 'label must be at most 50 characters')
      .refine((value) => !hasControlCharacters(value), 'label must not contain control characters'),
  })
  .strict();

export type CreateAccountBody = z.infer<typeof createAccountSchema>;
