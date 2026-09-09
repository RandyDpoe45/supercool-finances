import { Controller, Get } from '@nestjs/common';

/**
 * FOUNDATION SCAFFOLDING (spec 03): a single service-token-guarded probe so the
 * `/internal` service-identity guard is demonstrable. Requires the
 * `X-Service-Token` header (unlike `GET /internal/health`, which is exempt). Real
 * `/internal` endpoints arrive with the stream consumer in spec 05.
 */
@Controller('internal')
export class InternalController {
  @Get('ping')
  ping(): { pong: true } {
    return { pong: true };
  }
}
