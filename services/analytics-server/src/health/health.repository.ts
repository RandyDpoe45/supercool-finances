import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { IHealthRepository } from './health-repository.interface';

/** Mongoose connection readyState `1` === connected. */
const CONNECTED = 1;

/**
 * Concrete Mongo implementation of {@link IHealthRepository}, bound to the token
 * in {@link HealthModule}. Establishes the interface-behind-token DI pattern the
 * readiness check uses to prove DB connectivity: it confirms the connection is
 * established and issues a lightweight `ping` admin command (allowed for any
 * authenticated user, so the least-privilege `analytics` user can run it).
 */
@Injectable()
export class HealthRepository implements IHealthRepository {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async checkConnection(): Promise<boolean> {
    try {
      const db = this.connection.db;
      if (this.connection.readyState !== CONNECTED || !db) {
        return false;
      }
      await db.admin().ping();
      return true;
    } catch {
      return false;
    }
  }
}
