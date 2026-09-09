import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_CONFIG } from '../config/config.tokens';
import { AppConfig } from '../config/configuration';

/**
 * Wires the MongoDB connection from the injected {@link AppConfig} (the composed
 * DSN). Mongoose is the idiomatic driver here: spec 05's read-model collections
 * (`transactions`, `dailyAggregates`, …) will be mongoose schemas registered via
 * `MongooseModule.forFeature`, so the connection established here is their root.
 *
 * Mongo has no schema migrations (unlike the balance service's TypeORM) — the read
 * model is created lazily on first write, so there is no on-boot migration step.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ uri: config.mongo.dsn }),
    }),
  ],
})
export class DatabaseModule {}
