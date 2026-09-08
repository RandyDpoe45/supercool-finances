/** DI token for {@link IHealthRepository}. Consumers depend on the interface,
 * never the concrete TypeORM implementation (ADR: depend on interfaces/tokens). */
export const HEALTH_REPOSITORY = Symbol('HEALTH_REPOSITORY');

/** Readiness probe port: proves the service can reach its datastore. */
export interface IHealthRepository {
  /** Resolves `true` if a trivial query against Postgres succeeds, else `false`. */
  checkConnection(): Promise<boolean>;
}
