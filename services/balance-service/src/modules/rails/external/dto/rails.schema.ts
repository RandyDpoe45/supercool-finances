import { z } from 'zod';

/**
 * Wire-validation schemas for the rail webhooks on the `/external` surface, applied by the
 * reusable {@link ZodValidationPipe} at the controller boundary. They enforce the SHAPE of the
 * untrusted third-party payload (a security control against param mishandling / injection)
 * before it reaches the domain service; the service re-checks the business invariants it owns.
 * Money is a minor-unit digit string (never a JS number — int64 precision). Both are `.strict()`
 * so unknown keys are rejected (defense-in-depth against param smuggling).
 */

/** `POST /external/rails/settlement-callback` body — the outbound completion report, correlated
 * by OUR transaction id. `status` is the rail outcome; `externalRef` is the rail's reference. */
export const settlementCallbackSchema = z
  .object({
    transactionId: z.string().uuid(),
    status: z.enum(['success', 'failure']),
    externalRef: z.string().min(1),
  })
  .strict();
export type SettlementCallbackBody = z.infer<typeof settlementCallbackSchema>;

/** `POST /external/rails/inbound` body — a fresh external inbound credit addressed by the
 * customer's human 10-digit account number, deduplicated by the rail `externalRef`. `amount` is
 * an unsigned minor-unit integer string, > 0. */
export const inboundCreditSchema = z
  .object({
    accountNumber: z.string().regex(/^\d{10}$/, 'accountNumber must be a 10-digit numeric string'),
    amount: z
      .string()
      .regex(/^\d+$/, 'amount must be an unsigned minor-unit integer')
      .refine((value) => BigInt(value) > 0n, 'amount must be greater than zero'),
    currency: z.string().length(3),
    externalRef: z.string().min(1),
  })
  .strict();
export type InboundCreditBody = z.infer<typeof inboundCreditSchema>;
