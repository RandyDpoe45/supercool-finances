/** DI token for the shared ioredis client. Consumers inject the connection via this
 * token, never construct their own (single lifecycle-managed client per process). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
