import type { Request } from 'express';

/** The trusted identity derived from the gateway-injected headers (`/admin` only). */
export interface RequestIdentity {
  /** The token `sub`, injected by Kong as `X-User-Id`. Never taken from the body/query. */
  userId: string;
  /** Roles from the `X-Roles` header (comma-separated). */
  roles: string[];
}

/** Express request augmented by the foundation middleware/guards. */
export interface RequestWithIdentity extends Request {
  identity?: RequestIdentity;
  requestId?: string;
}
