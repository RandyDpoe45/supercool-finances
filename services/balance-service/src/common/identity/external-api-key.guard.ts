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
import { headerValue, prefixSegment } from './http-path.util';
import { RequestWithIdentity } from './request-identity';

/**
 * API-key guard for the `/external` surface — the third-party rail webhooks (outbound
 * settlement callback + inbound credit). Bound globally (APP_GUARD) so no `/external`
 * endpoint can skip it, and it scopes itself to the `external` prefix (every other prefix
 * is another guard's concern, returned early).
 *
 * `/external` is a DISTINCT trust domain from `/internal` (our own network peers,
 * `X-Service-Token`) and `/api` (customers behind the gateway, `X-User-Id`): the caller is a
 * third-party rail, not a user or a peer service, so it authenticates with a dedicated shared
 * secret (`X-Api-Key` == `RAILS_WEBHOOK_API_KEY`, constant-time compared) and NOTHING else —
 * never a user JWT, never the service token. A missing or mismatched key is 401. There is NO
 * health carve-out here: `/external` carries no health probe (health lives on `/internal`).
 */
@Injectable()
export class ExternalApiKeyGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    // Case-insensitive prefix match: Express routes `/EXTERNAL/*` here too, so we must fail
    // closed and still demand the key (see prefixSegment).
    if (prefixSegment(request.path) !== 'external') {
      return true;
    }

    const apiKey = headerValue(request.headers['x-api-key']);
    if (!apiKey || !constantTimeEquals(apiKey, this.config.rails.webhookApiKey)) {
      throw new UnauthorizedException('Invalid or missing API key');
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
