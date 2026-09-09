import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.tokens';
import { AppConfig } from '../config/configuration';
import { REDIS_CLIENT } from './redis.tokens';

/**
 * Global provider of the single lifecycle-managed ioredis client, bound behind the
 * {@link REDIS_CLIENT} token (consumers inject the token, never construct their own).
 * `@Global` so importing this module ONCE (in AppModule) makes the token resolvable
 * everywhere — the OTP module and the step-6 outbox relay both reuse this one client.
 *
 * Boot resilience (the non-obvious *why*):
 * - `lazyConnect: true` — no socket is opened until the first command, so booting
 *   AppModule while Redis is down neither connects nor throws (e2e/integration tests
 *   that boot AppModule without Redis must not fail here).
 * - An `'error'` handler is attached before the client is returned: ioredis emits
 *   `'error'` on connection trouble and, if unhandled, an EventEmitter `'error'` is
 *   thrown and would crash the process. The handler swallows it (retry/backoff is
 *   ioredis's job) so a transient Redis outage degrades commands, not the process.
 * - `maxRetriesPerRequest: null` — never give up retrying a queued command across a
 *   reconnect (surface a failure via the command promise, not a hard cap).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis => {
        const client = new Redis(config.redis.url, {
          lazyConnect: true,
          maxRetriesPerRequest: null,
        });
        client.on('error', () => {
          // Swallow: ioredis owns reconnect/backoff; an unhandled 'error' would crash
          // the process. Command-level failures still reject their own promises.
        });
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  /** Close the connection on shutdown with a graceful QUIT. Guarded: on a connected
   * client whose Redis became unreachable mid-shutdown, `quit()` can reject — we don't
   * want that surfacing as a rejected `app.close()`. Safe on a never-connected lazy
   * client too (ioredis does a transient connect then disconnects; still resolves). */
  onModuleDestroy(): Promise<'OK'> {
    return this.client.quit().catch(() => 'OK' as const);
  }
}
