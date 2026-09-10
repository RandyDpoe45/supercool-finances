/**
 * Map an RTK Query error into a short human phrase for the page's error state. RTK Query
 * surfaces either a `FetchBaseQueryError` (has `status`) or a `SerializedError`; this only
 * needs the status to give the customer a meaningful message and never leaks the raw
 * error envelope into the UI.
 */
export function describeApiError(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (status === 401) {
      return 'not signed in';
    }
    if (status === 404) {
      return 'not found';
    }
    return `HTTP ${String(status)}`;
  }
  return 'unknown error';
}
