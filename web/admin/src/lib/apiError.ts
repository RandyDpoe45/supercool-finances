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

/**
 * Map an RTK Query error into a short human phrase for a page's error state. Reads the normalized
 * `{ status, code, message }` and never leaks the raw error envelope into the UI. `401` reads as a
 * signed-out session (the fail-closed gate should catch this first); a `code` from the service
 * envelope is preferred when present, otherwise the HTTP status.
 */
export function describeApiError(error: unknown): string {
  const parsed = parseApiError(error);
  if (parsed.status === 401) {
    return 'not signed in';
  }
  if (parsed.code) {
    return parsed.code;
  }
  if (parsed.status !== undefined) {
    return `HTTP ${parsed.status}`;
  }
  return 'unknown error';
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
