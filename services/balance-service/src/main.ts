import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config/config.tokens';
import { AppConfig } from './config/configuration';
import { parseEnv } from './config/env.schema';

/**
 * Bootstrap order (spec 03):
 *   1. validate config (fail fast)  ->  2. create app (TypeORM runs migrations on
 *   boot via migrationsRun)  ->  3. cross-cutting middleware; global guards +
 *   exception filter are bound in AppModule  ->  4. listen.
 */
async function bootstrap(): Promise<void> {
  // Standalone runs read a local `.env` (Node native). In Docker the vars come
  // from the compose `environment:` block, so no `.env` file is present.
  try {
    const proc = process as NodeJS.Process & { loadEnvFile?: (path?: string) => void };
    proc.loadEnvFile?.();
  } catch {
    // No .env file — rely on the ambient environment.
  }

  // 1. Fail fast on invalid config, before anything else boots.
  try {
    parseEnv(process.env);
  } catch (error) {
    // Config/logging are not yet wired, so use console + a hard non-zero exit.
    console.error(`[config] ${(error as Error).message}`);
    process.exit(1);
  }

  // 2. Create the app — migrations run during DataSource init (before listen).
  //    Global guards, the exception filter, and the request-id middleware are all
  //    bound in AppModule, so the module carries those guarantees on its own.
  const app = await NestFactory.create(AppModule);

  // 3. Listen.
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
  new Logger('Bootstrap').log(`balance-service listening on port ${config.port}`);
}

void bootstrap();
