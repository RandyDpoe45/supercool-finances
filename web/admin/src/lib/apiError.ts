import type { ErrorResponse } from '../services/api/contracts/error';

/**
 * A normalized read of an RTK Query error. `status` is the HTTP status (when the failure
 * was an HTTP response); `code`/`message` come from the service-wide `{ error }` envelope
 * when present. All optional: a network/parse failure carries none of them.
 */
export interface ParsedApiError {
  status?: number;
  code?: string;
  message?: string;
}

/**
 * Extract `{ status, code, message }` from an unknown RTK Query error without assuming its
 * shape. Handles `FetchBaseQueryError` (`{ status, data }`) and the service `ErrorResponse`
 * envelope in `data`; returns an empty object for anything else, so callers always get a
 * safe object to branch on.
 */
export function parseApiError(error: unknown): ParsedApiError {
  if (error === null || typeof error !== 'object') {
    return {};
  }
  const parsed: ParsedApiError = {};
  if ('status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') {
      parsed.status = status;
    }
  }
  if ('data' in error && isErrorResponse((error as { data: unknown }).data)) {
    const envelope = (error as { data: ErrorResponse }).data;
    parsed.code = envelope.error.code;
    parsed.message = envelope.error.message;
  }
  return parsed;
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (value === null || typeof value !== 'object' || !('error' in value)) {
    return false;
  }
  const inner = (value as { error: unknown }).error;
  return (
    inner !== null &&
    typeof inner === 'object' &&
    typeof (inner as { code: unknown }).code === 'string' &&
    typeof (inner as { message: unknown }).message === 'string'
  );
}
