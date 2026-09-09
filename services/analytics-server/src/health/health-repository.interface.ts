/** DI token for {@link IHealthRepository}. Consumers depend on the interface,
 * never the concrete Mongo implementation (ADR: depend on interfaces/tokens). */
export const HEALTH_REPOSITORY = Symbol('HEALTH_REPOSITORY');

/** Readiness probe port: proves the service can reach its datastore. */
export interface IHealthRepository {
  /** Resolves `true` if MongoDB is connected and answers a ping, else `false`. */
  checkConnection(): Promise<boolean>;
}
