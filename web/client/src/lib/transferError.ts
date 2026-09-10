import { describeApiError } from './apiError';

/**
 * Map a transfers `/api` error into UI concerns. The balance service returns the single error
 * envelope `{ error: { code, message, requestId } }` with a STABLE domain `code` (e.g.
 * `SUSPECTED_DUPLICATE`, `INVALID_OTP`), so the UI keys off the CODE — not the raw HTTP status —
 * both to show a clear message and to branch the flow (a suspected duplicate offers "confirm
 * anyway"; an expired transfer restarts). The raw envelope is never rendered verbatim.
 */

/** The transfer domain codes the client acts on. Others fall through to the generic message. */
export type TransferErrorCode =
  | 'SUSPECTED_DUPLICATE'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PENDING_TRANSFER_CONFLICT'
  | 'DESTINATION_NOT_CONFIRMED'
  | 'INVALID_TRANSFER'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'LIMIT_EXCEEDED'
  | 'ACCOUNT_FROZEN'
  | 'TRANSFER_NOT_FOUND'
  | 'TRANSFER_NOT_PENDING'
  | 'TRANSFER_EXPIRED'
  | 'INVALID_OTP'
  | 'OTP_LOCKED_OUT'
  // External payees + external outbound (this step).
  | 'PAYEE_NOT_FOUND'
  | 'PAYEE_IN_COOLING_OFF'
  | 'PAYEE_ALREADY_ENROLLED';

const MESSAGES: Record<TransferErrorCode, string> = {
  SUSPECTED_DUPLICATE:
    'This looks like a duplicate of a recent payment. Confirm to send it anyway.',
  IDEMPOTENCY_KEY_REUSED:
    'This request was already used with different details. Start the transfer again.',
  PENDING_TRANSFER_CONFLICT: 'You already have a transfer awaiting confirmation.',
  DESTINATION_NOT_CONFIRMED:
    'The destination confirmation expired. Please look up and confirm the account again.',
  INVALID_TRANSFER: 'This transfer is not valid. Check the account and amount.',
  CURRENCY_MISMATCH: 'The source and destination currencies do not match.',
  INSUFFICIENT_FUNDS: 'Insufficient funds in the selected account.',
  LIMIT_EXCEEDED: 'This transfer exceeds your spending limit.',
  ACCOUNT_FROZEN: 'The selected account is frozen and cannot send money.',
  TRANSFER_NOT_FOUND: 'That transfer or account could not be found.',
  TRANSFER_NOT_PENDING: 'This transfer can no longer be changed.',
  TRANSFER_EXPIRED: 'This transfer expired before it was confirmed. Please start again.',
  INVALID_OTP: 'That one-time code is invalid. Check the code from your OTP app and try again.',
  OTP_LOCKED_OUT: 'Too many invalid attempts. Request a new one-time code from your OTP app.',
  // A missing/non-owned payee collapses to a single 404 (anti-enumeration); the message never
  // reveals whether the payee exists.
  PAYEE_NOT_FOUND: 'That payee could not be found.',
  PAYEE_IN_COOLING_OFF:
    'This payee is still in its cooling-off period and cannot receive money yet.',
  PAYEE_ALREADY_ENROLLED: 'You have already enrolled a payee for this account.',
};

/** Extract the domain `code` from an RTK Query error's envelope (`FetchBaseQueryError.data`),
 * defensively — a transport failure (no envelope) yields `undefined`. */
export function transferErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('data' in error)) {
    return undefined;
  }
  const data = (error as { data: unknown }).data;
  if (data === null || typeof data !== 'object' || !('error' in data)) {
    return undefined;
  }
  const envelope = (data as { error: unknown }).error;
  if (envelope === null || typeof envelope !== 'object' || !('code' in envelope)) {
    return undefined;
  }
  const code = (envelope as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** A short, human message for a transfers error: the mapped message for a known domain code,
 * else the (PII-light, safe-to-surface) envelope message, else the generic transport phrase. */
export function describeTransferError(error: unknown): string {
  const code = transferErrorCode(error);
  if (code && code in MESSAGES) {
    return MESSAGES[code as TransferErrorCode];
  }
  const envelopeMessage = extractEnvelopeMessage(error);
  if (envelopeMessage) {
    return envelopeMessage;
  }
  return `Something went wrong (${describeApiError(error)}).`;
}

function extractEnvelopeMessage(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('data' in error)) {
    return undefined;
  }
  const data = (error as { data: unknown }).data;
  if (data === null || typeof data !== 'object' || !('error' in data)) {
    return undefined;
  }
  const envelope = (data as { error: unknown }).error;
  if (envelope === null || typeof envelope !== 'object' || !('message' in envelope)) {
    return undefined;
  }
  const message = (envelope as { message: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}
