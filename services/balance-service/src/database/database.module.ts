import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG } from '../config/config.tokens';
import { AppConfig } from '../config/configuration';
import { buildDataSourceOptions } from './data-source.options';

/**
 * Wires TypeORM from the injected {@link AppConfig} (the composed DSN). Because the
 * options set `migrationsRun: true`, the DataSource applies pending migrations
 * during initialization — i.e. before the HTTP server starts listening.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildDataSourceOptions(config),
    }),
  ],
})
export class DatabaseModule {}
