import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestIdentity, RequestWithIdentity } from './request-identity';

/**
 * Injects the typed {@link RequestIdentity} set by {@link GatewayIdentityGuard}.
 * Only populated on `/admin` routes (analytics has no `/api` — customers never
 * query it).
 */
export const Identity = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestIdentity | undefined => {
    const request = ctx.switchToHttp().getRequest<RequestWithIdentity>();
    return request.identity;
  },
);
