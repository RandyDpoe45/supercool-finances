import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { headerValue, prefixSegment } from './http-path.util';
import { RequestIdentity, RequestWithIdentity } from './request-identity';

const ADMIN_ROLE = 'admin';

/**
 * Gateway identity guard for the `/api` and `/admin` surfaces. Bound globally
 * (APP_GUARD) so no endpoint on those prefixes can skip it.
 *
 * Trust model (ADR-2/ADR-3): the service trusts ONLY the Kong-injected headers —
 * `X-User-Id` (the token `sub`) and `X-Roles` — never a user id from the body or
 * query. A missing `X-User-Id` means the request did not pass through Kong, so it
 * is rejected 401. `/admin` additionally requires the `admin` role (403 otherwise).
 * Requests outside `/api` and `/admin` are not this guard's concern.
 */
@Injectable()
export class GatewayIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    // Case-insensitive prefix match: Express routes `/API/*` and `/ADMIN/*` here
    // too, so we must fail closed and still demand identity (see prefixSegment).
    const segment = prefixSegment(request.path);
    if (segment !== 'api' && segment !== 'admin') {
      return true;
    }

    const userId = headerValue(request.headers['x-user-id']);
    if (!userId) {
      throw new UnauthorizedException('Missing gateway identity');
    }

    const roles = parseRoles(request.headers['x-roles']);
    const identity: RequestIdentity = { userId, roles };
    request.identity = identity;

    if (segment === 'admin' && !roles.includes(ADMIN_ROLE)) {
      throw new ForbiddenException('Admin role required');
    }

    return true;
  }
}

function parseRoles(raw: string | string[] | undefined): string[] {
  const value = headerValue(raw);
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
}
