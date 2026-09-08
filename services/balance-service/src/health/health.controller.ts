import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HEALTH_REPOSITORY, IHealthRepository } from './health-repository.interface';

type Up = 'up' | 'down';

interface HealthStatus {
  status: 'ok' | 'error';
  /** The process is up and serving — always `up` if this handler runs. */
  liveness: Up;
  /** Dependencies (Postgres) are reachable. */
  readiness: Up;
  checks: { db: Up };
}

/**
 * `GET /internal/health` — backs the Docker healthcheck. Liveness is implicit
 * (a response at all means the process is up); readiness pings Postgres via the
 * injected {@link IHealthRepository}. Returns 200 when ready, 503 when not — the
 * healthcheck fails the container on a 503. This route is exempt from the
 * service-identity guard so the probe needs no credentials.
 */
@Controller('internal')
export class HealthController {
  constructor(@Inject(HEALTH_REPOSITORY) private readonly health: IHealthRepository) {}

  @Get('health')
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthStatus> {
    const dbUp = await this.health.checkConnection();
    res.status(dbUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: dbUp ? 'ok' : 'error',
      liveness: 'up',
      readiness: dbUp ? 'up' : 'down',
      checks: { db: dbUp ? 'up' : 'down' },
    };
  }
}
