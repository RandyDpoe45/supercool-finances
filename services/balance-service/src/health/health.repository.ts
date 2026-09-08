import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IHealthRepository } from './health-repository.interface';

/**
 * Concrete TypeORM implementation of {@link IHealthRepository}, bound to the token
 * in {@link HealthModule}. Establishes the interface-behind-token DI pattern the
 * readiness check uses to prove DB connectivity.
 */
@Injectable()
export class HealthRepository implements IHealthRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async checkConnection(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
