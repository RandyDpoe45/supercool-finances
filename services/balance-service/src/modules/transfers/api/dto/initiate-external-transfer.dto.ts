import { z } from 'zod';
import { initiateExternalTransferSchema } from './transfers.schema';

/**
 * The `POST /api/transfers/external` request body (the wire contract). Derived from
 * {@link initiateExternalTransferSchema} so the validated shape and this type can never drift:
 * the ZodValidationPipe parses the untrusted body against the schema, and the controller receives
 * a value of exactly this type. The destination is an ENROLLED payee addressed by `payeeId`
 * (there is no resolve/confirm step for external outbound); `currency` and the positive minor-unit
 * `amount` are re-checked by the service. The `Idempotency-Key` travels in the header, and the
 * caller identity comes from the gateway — never the body.
 */
export type InitiateExternalTransferBody = z.infer<typeof initiateExternalTransferSchema>;
