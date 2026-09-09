import { DataSource, QueryRunner } from 'typeorm';

/** Postgres SQLSTATE for a detected deadlock — the ONLY error a money transaction retries. */
const DEADLOCK_SQLSTATE = '40P01';

/** Default bounded retries on a deadlock (total attempts = 1 + this). Deadlocks are rare
 * given canonical lock ordering; a small bound absorbs the occasional loser without livelock. */
const DEFAULT_MAX_DEADLOCK_RETRIES = 3;

/** The Postgres isolation levels TypeORM's `startTransaction` accepts (mirrors its own union,
 * declared locally to avoid depending on the barrel export). */
type IsolationLevel = 'READ UNCOMMITTED' | 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface RunInTransactionOptions {
  /** Isolation level for the transaction. Defaults to `READ COMMITTED` (ADR-13). */
  isolationLevel?: IsolationLevel;
  /** Max retries on a deadlock. Defaults to {@link DEFAULT_MAX_DEADLOCK_RETRIES}. */
  maxDeadlockRetries?: number;
}

/**
 * True iff the error is (or wraps) a Postgres deadlock (SQLSTATE 40P01). TypeORM surfaces the
 * driver error as `QueryFailedError`; the SQLSTATE lives on the error or its `driverError`, so
 * both are checked.
 */
export function isDeadlockError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  return candidate.code === DEADLOCK_SQLSTATE || candidate.driverError?.code === DEADLOCK_SQLSTATE;
}

/**
 * Run `fn` inside ONE DB transaction and commit it, retrying ONLY on a deadlock. The single
 * seam every money-mutating operation opens its transaction through (the posting reducer and
 * the idempotency wrapper), so the concurrency mechanics (isolation, deadlock-retry, rollback,
 * release) live in exactly one place.
 *
 * A fresh `QueryRunner` is created, connected, and started at the given isolation level; on
 * success the transaction is committed and `fn`'s result returned. On a deadlock (`40P01`) the
 * transaction is rolled back and retried in a NEW transaction (bounded); on any other error it
 * is rolled back and the error rethrown. The query runner is ALWAYS released.
 *
 * `fn` is re-invoked per attempt, so any ids/values it captures from an outer closure stay
 * stable across retries (e.g. a transaction id generated up front).
 */
export async function runInTransactionWithRetry<T>(
  dataSource: DataSource,
  fn: (queryRunner: QueryRunner) => Promise<T>,
  options: RunInTransactionOptions = {},
): Promise<T> {
  const isolationLevel = options.isolationLevel ?? 'READ COMMITTED';
  const maxRetries = options.maxDeadlockRetries ?? DEFAULT_MAX_DEADLOCK_RETRIES;

  for (let attempt = 0; ; attempt += 1) {
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction(isolationLevel);
    try {
      const result = await fn(queryRunner);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      if (isDeadlockError(error) && attempt < maxRetries) {
        continue;
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
