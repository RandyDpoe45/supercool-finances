/**
 * App-local copy of the service-wide error envelope (mirrors balance-service
 * `common/errors/error-response.ts`). Every 4xx/5xx from `/balance/admin` uses this shape;
 * `requestId` threads the correlation id for tracing. Kept in sync via the spec
 * (ADR-16 — no cross-folder imports).
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}
