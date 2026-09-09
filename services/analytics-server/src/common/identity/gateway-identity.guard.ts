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
 * Gateway identity guard for the `/admin` surface. Bound globally (APP_GUARD) so
 * no `/admin` endpoint can skip it. The analytics server has NO `/api` (customers
 * never query it — ADR-12), so this guard governs the admin plane only.
 *
 * Trust model (ADR-2/ADR-3): the service trusts ONLY the Kong-injected headers —
 * `X-User-Id` (the token `sub`) and `X-Roles` — never a user id from the body or
 * query. A missing `X-User-Id` means the request did not pass through the internal
 * Kong, so it is rejected 401. `/admin` additionally requires the `admin` role
 * (403 otherwise). Requests outside `/admin` are not this guard's concern.
 */
@Injectable()
export class GatewayIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    // Case-insensitive prefix match: Express routes `/ADMIN/*` here too, so we
    // must fail closed and still demand identity (see prefixSegment).
    if (prefixSegment(request.path) !== 'admin') {
      return true;
    }

    const userId = headerValue(request.headers['x-user-id']);
    if (!userId) {
      throw new UnauthorizedException('Missing gateway identity');
    }

    const roles = parseRoles(request.headers['x-roles']);
    const identity: RequestIdentity = { userId, roles };
    request.identity = identity;

    if (!roles.includes(ADMIN_ROLE)) {
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
