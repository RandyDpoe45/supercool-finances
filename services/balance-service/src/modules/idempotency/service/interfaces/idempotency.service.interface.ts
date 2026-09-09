import { QueryRunner } from 'typeorm';
import { FingerprintInput } from '../fingerprint';

/** DI token for {@link IIdempotencyService}. Consumers depend on the interface via this token,
 * never the concrete class. */
export const IDEMPOTENCY_SERVICE = Symbol('IDEMPOTENCY_SERVICE');

/** Inputs to {@link IIdempotencyService.execute}. */
export interface IdempotencyParams {
  ownerId: string;
  key: string;
  fingerprintInput: FingerprintInput;
  /** When true, override a suspected soft-duplicate and proceed (an explicit confirm). */
  confirmDuplicate?: boolean;
}

/** The wrapped money movement: runs INSIDE the wrapper's transaction and returns the id of
 * the transaction it posted. */
export type IdempotentOperation = (queryRunner: QueryRunner) => Promise<{ transactionId: string }>;

/** Outcome of {@link IIdempotencyService.execute}: the resulting transaction id and whether
 * this call replayed a prior result (money moved 0 additional times) or performed it fresh. */
export interface IdempotencyOutcome {
  transactionId: string;
  replayed: boolean;
}

/** A generic at-most-once wrapper for money-moving requests with soft duplicate-suppression
 * (spec 04 Transfers), decoupled from posting. */
export interface IIdempotencyService {
  execute(params: IdempotencyParams, operation: IdempotentOperation): Promise<IdempotencyOutcome>;
}
