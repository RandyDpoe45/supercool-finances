import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { Identity } from '../../common/identity/identity.decorator';
import { RequestIdentity } from '../../common/identity/request-identity';

/**
 * FOUNDATION SCAFFOLDING (spec 03): a single guarded probe so the customer-plane
 * gateway guard is demonstrable end to end. The real `/api` money endpoints arrive
 * in spec 04. Reaching this route requires the Kong-injected `X-User-Id`.
 */
@Controller('api')
export class ApiController {
  @Get('whoami')
  whoami(@Identity() identity: RequestIdentity | undefined): RequestIdentity {
    if (!identity) {
      // The global guard populates identity for `/api`; this is a defensive guard.
      throw new UnauthorizedException('Missing gateway identity');
    }
    return identity;
  }
}
