/**
 * App-local copy of the balance-service transfers `/api` wire contract (mirrors the transfers
 * serializer, DTOs, and request schemas). Per ADR-16 (self-contained components, no cross-folder
 * imports) this SPA keeps its OWN copy rather than importing from the service; the specs
 * (`specs/07-frontends.md`, `specs/04-balance-service.md`, `specs/balance-schema.yaml`) are the
 * contract of record.
 *
 * Money (`amount`) is a canonical bigint minor-unit STRING — never a JS number (int64 precision).
 * The client whitelist thinking mirrors the server serializer: the internal columns the service
 * deliberately withholds (`initiatedBy` / `payeeId` / `failureReason` / `failedAt` /
 * `reversesTransactionId` / the raw credit account id) are simply ABSENT here and must never be
 * rendered or stored. `status` values are UPPERCASE and `type` values lowercase, matching the
 * native DB enums.
 */

/** Transaction type as the wire carries it. `internal` is the only one this step initiates;
 * the others can appear in the shared pending feed / confirm response. */
export type TransferType = 'internal' | 'external_outbound' | 'external_inbound';

/** Transaction lifecycle status (UPPERCASE, matching the native `transaction_status` enum). */
export type TransferStatus = 'PENDING' | 'POSTED' | 'FAILED' | 'REVERSED' | 'EXPIRED' | 'CANCELLED';

/**
 * Customer-facing view of a transfer on `POST /api/transfers`, `.../:id/confirm`, `.../:id/cancel`.
 * `sourceAccountId` is the caller's own account id (exposed exactly like `AccountDto.id`); the
 * destination is NOT echoed here (the client supplied / holds it). `expiresAt` is the 2-minute
 * pending deadline (null once posted / never pending); `postedAt` is null while PENDING.
 */
export interface TransferDto {
  id: string;
  type: TransferType;
  status: TransferStatus;
  amount: string;
  currency: string;
  sourceAccountId: string | null;
  createdAt: string;
  expiresAt: string | null;
  postedAt: string | null;
}

/** Confirmation-of-payee result on `POST /api/transfers/resolve-destination`. `maskedName` is the
 * destination holder's name masked by the service (the raw PII never reaches the wire);
 * `confirmationToken` is single-use, caller-bound, and REQUIRED by `POST /api/transfers`. */
export interface ResolveDestinationDto {
  maskedName: string;
  currency: string;
  confirmationToken: string;
}

/** The caller's SINGLE active PENDING transfer on `GET /api/pending-authorization`. For an
 * `internal` transfer the destination is the human account number + masked holder name; for
 * `external_outbound` it is the enrolled payee's display name (the other set is null). */
export interface PendingAuthorizationDto {
  transferId: string;
  type: TransferType;
  amount: string;
  currency: string;
  sourceAccountId: string | null;
  destinationAccountNumber: string | null;
  destinationMaskedName: string | null;
  payeeDisplayName: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Envelope returned by `GET /api/pending-authorization`. */
export interface PendingAuthorizationResponse {
  authorization: PendingAuthorizationDto | null;
}

/** Body of `POST /api/transfers/resolve-destination` — a 10-digit destination account number. */
export interface ResolveDestinationRequest {
  accountNumber: string;
}

/**
 * Arguments to the `initiateTransfer` mutation. `idempotencyKey` is sent as the `Idempotency-Key`
 * HEADER (not a body field) and is REUSED across retries of the same logical transfer, so a retry
 * never double-submits. `amount` is a minor-unit integer string. `confirmDuplicate` re-submits an
 * identical payment the service flagged as a suspected soft-duplicate.
 */
export interface InitiateTransferRequest {
  idempotencyKey: string;
  sourceAccountId: string;
  destinationAccountNumber: string;
  amount: string;
  currency: string;
  confirmationToken: string;
  confirmDuplicate?: boolean;
}

/**
 * Arguments to the `initiateExternalTransfer` mutation — an external outbound to an ENROLLED payee,
 * addressed by `payeeId` (there is NO resolve/confirmation-token step; the cooling-off delay is the
 * anti-fraud gate). The service schema is `.strict()`, so ONLY the wire fields below may be sent.
 * `idempotencyKey` rides the `Idempotency-Key` HEADER (not the body) and is REUSED across retries of
 * the same logical transfer. Unlike an internal initiate, this places a HOLD immediately — the
 * source account's `available` drops at once — so its cache invalidation differs (see
 * `transfersApi`). `amount` is a minor-unit integer string.
 */
export interface InitiateExternalTransferRequest {
  idempotencyKey: string;
  sourceAccountId: string;
  payeeId: string;
  amount: string;
  currency: string;
  confirmDuplicate?: boolean;
}

/** Arguments to the `confirmTransfer` mutation — the pending transfer id + the out-of-band code
 * the user obtained from the OTP app (a numeric string). */
export interface ConfirmTransferRequest {
  transferId: string;
  code: string;
}

/** Arguments to the `cancelTransfer` mutation — the pending transfer id. */
export interface CancelTransferRequest {
  transferId: string;
}
