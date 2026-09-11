import { DeepPartial, QueryRunner } from 'typeorm';
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { ApprovalStatus } from '../../entities/enums';

/** DI token for {@link IApprovalRequestRepository}. */
export const APPROVAL_REQUEST_REPOSITORY = Symbol('APPROVAL_REQUEST_REPOSITORY');

/** Persistence port for {@link ApprovalRequest} (maker-checker). The two guarded status
 * transitions (`transitionToExecutedInTx` / `transitionToRejectedInTx`) set `checker_id` in the
 * SAME UPDATE that decides the request — the domain service MUST have already verified
 * `checkerId !== makerId`, else the DB CHECK (`checker_id IS NULL OR checker_id <> maker_id`)
 * fires. Both transitions are guarded on `status = 'PENDING'` so exactly one checker can decide a
 * request under a concurrent race (returns `true` iff this call won). */
export interface IApprovalRequestRepository {
  findById(id: string): Promise<ApprovalRequest | null>;
  create(data: DeepPartial<ApprovalRequest>): Promise<ApprovalRequest>;
  /** Insert one approval request INSIDE the caller's transaction (via `queryRunner.manager`), so
   * the row and its `reversal.proposed` audit row commit (or roll back) together. Presetting `id`
   * is not required — the DB default (`gen_random_uuid()`) fills it and it is re-read merged onto
   * the returned entity. */
  createInTx(
    queryRunner: QueryRunner,
    data: DeepPartial<ApprovalRequest>,
  ): Promise<ApprovalRequest>;
  /** Read one approval request INSIDE the caller's transaction, so it sees that tx's own
   * uncommitted writes (e.g. the just-applied status transition). */
  findByIdInTx(queryRunner: QueryRunner, id: string): Promise<ApprovalRequest | null>;
  /** Every approval request targeting a given transaction (any status). Backs the propose-time
   * duplicate guard (reject a new proposal when a PENDING or EXECUTED one already exists). */
  findByTargetTransaction(targetTransactionId: string): Promise<ApprovalRequest[]>;
  /** Admin-scoped approvals query (spec 04 "Admin ops" — `GET /approvals`, the checker's queue). All
   * approvals in the given `status`, `ORDER BY created_at DESC` (id tiebreak for determinism). No
   * `FOR UPDATE`, no paging (approval rows are few). The service applies the default status (PENDING)
   * before calling this — the checker's queue is the default view. */
  listByStatus(status: ApprovalStatus): Promise<ApprovalRequest[]>;
  /** Guarded `PENDING → EXECUTED` transition inside the caller's transaction:
   * `UPDATE approval_request SET status = 'EXECUTED', checker_id = :checkerId, decided_at = now(),
   * executed_at = now() WHERE id = :id AND status = 'PENDING'`. Returns `true` iff exactly one row
   * was updated; `false` (0 rows) means a concurrent checker already decided it. This single
   * guarded write is the maker-checker concurrency gate (two simultaneous checkers → exactly one
   * execution). `checker_id` is set here, so the service must have verified `checkerId <> makerId`
   * first. MUST run inside the given queryRunner's active transaction. */
  transitionToExecutedInTx(
    queryRunner: QueryRunner,
    id: string,
    checkerId: string,
  ): Promise<boolean>;
  /** Guarded `PENDING → REJECTED` transition inside the caller's transaction:
   * `UPDATE approval_request SET status = 'REJECTED', checker_id = :checkerId, decided_at = now()
   * WHERE id = :id AND status = 'PENDING'`. Returns `true` iff exactly one row was updated; `false`
   * (0 rows) means it was already decided. `checker_id` is set here, so the service must have
   * verified `checkerId <> makerId` first. MUST run inside the given queryRunner's active
   * transaction. */
  transitionToRejectedInTx(
    queryRunner: QueryRunner,
    id: string,
    checkerId: string,
  ): Promise<boolean>;
}
