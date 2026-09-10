import { z } from 'zod';

/**
 * Wire-validation schemas for the transfers `/api` surface, applied by the reusable
 * {@link ZodValidationPipe} at the controller boundary. These enforce the SHAPE of untrusted
 * input (a security control against param mishandling / injection) before it reaches the
 * domain service; the service re-checks the business invariants it owns. Money is a
 * minor-unit digit string (never a JS number, to preserve int64 precision).
 */

/** A human account number — a 10-digit numeric string (the transfer destination identifier). */
const accountNumberSchema = z
  .string()
  .regex(/^\d{10}$/, 'accountNumber must be a 10-digit numeric string');

/** `POST /api/transfers/resolve-destination` body — the confirmation-of-payee query. */
export const resolveDestinationSchema = z.object({
  accountNumber: accountNumberSchema,
});
export type ResolveDestinationBody = z.infer<typeof resolveDestinationSchema>;

/** `POST /api/transfers` body. The destination is addressed by its human account number; a
 * `confirmationToken` from a prior resolve is REQUIRED (initiate cannot run without it).
 * `amount` is an unsigned minor-unit integer string, > 0. */
export const initiateTransferSchema = z.object({
  sourceAccountId: z.string().uuid(),
  destinationAccountNumber: accountNumberSchema,
  amount: z
    .string()
    .regex(/^\d+$/, 'amount must be an unsigned minor-unit integer')
    .refine((value) => BigInt(value) > 0n, 'amount must be greater than zero'),
  currency: z.string().length(3),
  confirmationToken: z.string().min(1),
  confirmDuplicate: z.boolean().optional(),
});
export type InitiateTransferBody = z.infer<typeof initiateTransferSchema>;

/** `POST /api/transfers/:id/confirm` body. `code` is a non-empty numeric string. */
export const confirmTransferSchema = z.object({
  code: z.string().regex(/^\d+$/, 'code must be a numeric string'),
});
export type ConfirmTransferBody = z.infer<typeof confirmTransferSchema>;

/** The required `Idempotency-Key` header — a non-empty string; a missing header (undefined)
 * fails validation → 400. */
export const idempotencyKeySchema = z.string().min(1);
