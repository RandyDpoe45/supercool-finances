import { DataSource } from 'typeorm';
import { loadConfig } from '../config/configuration';
import { buildDataSourceOptions } from './data-source.options';

/**
 * Standalone DataSource for the TypeORM CLI (migration generate/run/revert).
 *
 * IMPORTANT: this module has an import-time side effect (it validates the env and
 * builds a DataSource), so it must NEVER be imported by the application module
 * graph — only the CLI references it via `-d src/database/data-source.ts`. The app
 * itself runs migrations on boot through `migrationsRun` (see DatabaseModule).
 *
 * On-boot migrations use the compose `environment:` block; for standalone CLI runs
 * load a local `.env` first (Node native), e.g. `node --env-file=.env`.
 */
try {
  const proc = process as NodeJS.Process & { loadEnvFile?: (path?: string) => void };
  proc.loadEnvFile?.();
} catch {
  // No .env file present — rely on the ambient environment.
}

export const AppDataSource = new DataSource(buildDataSourceOptions(loadConfig()));
