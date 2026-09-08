import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from './config.tokens';
import { loadConfig } from './configuration';

/**
 * Global config module: validates the environment with zod and exposes the typed
 * {@link AppConfig} under the {@link APP_CONFIG} token. Validation runs during
 * module initialization (before the HTTP server listens), so an invalid
 * environment aborts boot.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
