import { z } from 'zod';

/**
 * Wire-validation schema for the payees `/api` surface, applied by the reusable
 * {@link ZodValidationPipe} at the controller boundary. It enforces the SHAPE of untrusted input
 * (a security control against param mishandling / injection) before it reaches the domain service.
 *
 * The rail is deliberately ABSENT — the outbound rail is a server-side constant, never accepted
 * from the caller. `.strict()` rejects any unknown key (so a client cannot smuggle `rail`,
 * `status`, `coolingOffUntil`, `ownerId`, … onto the enrollment).
 */

/** `POST /api/payees` body — minimal enrollment input. `displayName` is trimmed then bounded
 * (1..120 chars on the trimmed value); `destinationRef` is the external bank account number, a
 * 6–20 digit numeric string (a prototype bound). Unknown keys are rejected. */
export const registerPayeeSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    destinationRef: z
      .string()
      .regex(/^\d{6,20}$/, 'destinationRef must be a 6–20 digit numeric string'),
  })
  .strict();
export type RegisterPayeeBody = z.infer<typeof registerPayeeSchema>;
