import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { APP_CONFIG } from '../../config/config.tokens';
import { AppConfig } from '../../config/configuration';
import { headerValue, normalizePath, prefixSegment } from './http-path.util';
import { RequestWithIdentity } from './request-identity';

/** Health carve-out: liveness/readiness must be reachable by the Docker
 * healthcheck without service credentials, so `GET /internal/health` is exempt. */
const HEALTH_PATH = '/internal/health';

/**
 * Service-identity guard for the `/internal` surface. Bound globally (APP_GUARD)
 * so no `/internal` endpoint can skip it.
 *
 * `/internal` is never routed by a gateway (ADR-12); it is reachable only by peers
 * on the internal network. As defense in depth the service still requires a shared
 * secret (`X-Service-Token` == `INTERNAL_SERVICE_TOKEN`) — never a user JWT — and
 * rejects 401 otherwise. `GET /internal/health` is deliberately exempt (see above).
 */
@Injectable()
export class ServiceIdentityGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    // Case-insensitive prefix match: Express routes `/INTERNAL/*` here too, so we
    // must fail closed and still demand the token (see prefixSegment).
    if (prefixSegment(request.path) !== 'internal') {
      return true;
    }

    // Health carve-out: case-insensitive but EXACT so it can't be widened
    // (`/internal/health-and-secrets` stays guarded). HEALTH_PATH is lowercase.
    if (request.method === 'GET' && normalizePath(request.path).toLowerCase() === HEALTH_PATH) {
      return true;
    }

    const token = headerValue(request.headers['x-service-token']);
    if (!token || !constantTimeEquals(token, this.config.internalServiceToken)) {
      throw new UnauthorizedException('Invalid or missing service token');
    }

    return true;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
