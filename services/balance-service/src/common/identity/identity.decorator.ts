import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { RequestIdentity, RequestWithIdentity } from './request-identity';

/**
 * Injects the typed {@link RequestIdentity} set by {@link GatewayIdentityGuard}.
 * Only populated on `/api` and `/admin` routes (the gateway surfaces).
 */
export const Identity = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestIdentity | undefined => {
    const request = ctx.switchToHttp().getRequest<RequestWithIdentity>();
    return request.identity;
  },
);
