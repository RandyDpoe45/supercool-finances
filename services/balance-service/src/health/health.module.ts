import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HEALTH_REPOSITORY } from './health-repository.interface';
import { HealthRepository } from './health.repository';

@Module({
  controllers: [HealthController],
  providers: [{ provide: HEALTH_REPOSITORY, useClass: HealthRepository }],
})
export class HealthModule {}
