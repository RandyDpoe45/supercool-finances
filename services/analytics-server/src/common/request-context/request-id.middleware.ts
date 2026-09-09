import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Threads a correlation id through every request. It reuses an inbound
 * `X-Request-Id` (e.g. one set by the gateway) or mints a UUID, exposes it on the
 * request for the exception filter, and echoes it back on the response header.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const provided = (Array.isArray(incoming) ? incoming[0] : incoming)?.trim();
  const requestId = provided && provided.length > 0 ? provided : randomUUID();

  (req as Request & { requestId?: string }).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
