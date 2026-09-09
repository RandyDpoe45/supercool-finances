/** The one error DTO every service surface returns. `requestId` threads the
 * correlation id (see request-id.middleware.ts) so a client error can be traced. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

/** Stable machine-readable codes mapped from HTTP status. */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE_ENTITY';
    case 429:
      return 'TOO_MANY_REQUESTS';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}
