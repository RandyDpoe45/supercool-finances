import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { Identity } from '../../common/identity/identity.decorator';
import { RequestIdentity } from '../../common/identity/request-identity';

/**
 * FOUNDATION SCAFFOLDING (spec 03): a single guarded probe so the admin-plane
 * gateway guard is demonstrable. Reaching this route requires the Kong-injected
 * `X-User-Id` AND the `admin` role in `X-Roles`. The real `/admin` reporting API
 * (dashboard aggregates over the Mongo read model) arrives in spec 05.
 */
@Controller('admin')
export class AdminController {
  @Get('whoami')
  whoami(@Identity() identity: RequestIdentity | undefined): RequestIdentity {
    if (!identity) {
      throw new UnauthorizedException('Missing gateway identity');
    }
    return identity;
  }
}
