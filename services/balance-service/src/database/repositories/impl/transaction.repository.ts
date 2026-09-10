import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { TransactionStatus } from '../../entities/enums';
import { Transaction } from '../../entities/transaction.entity';
import { ITransactionRepository } from '../interfaces/transaction.repository.interface';

/** TypeORM implementation of {@link ITransactionRepository}, bound to
 * `TRANSACTION_REPOSITORY` in {@link PersistenceModule}. */
@Injectable()
export class TransactionRepository implements ITransactionRepository {
  constructor(@InjectRepository(Transaction) private readonly repo: Repository<Transaction>) {}

  findById(id: string): Promise<Transaction | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<Transaction>): Promise<Transaction> {
    return this.repo.save(this.repo.create(data));
  }

  insertInTx(queryRunner: QueryRunner, data: DeepPartial<Transaction>): Promise<Transaction> {
    // save() joins the queryRunner's transaction via its manager; DB-generated columns
    // (created_at) are returned merged onto the entity. The posting reducer presets `id`
    // to a freshly-generated UUID, so this can only ever INSERT — never an update.
    return queryRunner.manager.save(queryRunner.manager.create(Transaction, data));
  }

  async insertPendingInTx(
    queryRunner: QueryRunner,
    data: DeepPartial<Transaction>,
  ): Promise<Transaction> {
    // `expires_at` is stamped FROM THE DB CLOCK (`now() + interval '2 minutes'`), NOT the app
    // clock, so the 2-minute deadline is authoritative and consistent with the DB-defaulted
    // `created_at` (both resolve to the transaction's `now()`). An explicit parameterized INSERT
    // (as in the idempotency claim) keeps that raw expression precise without a client upsert;
    // the row is re-read within this same tx so the returned entity carries the DB-generated
    // `created_at` / `expires_at`. Presetting `id` means this can only ever INSERT.
    const id = data.id as string;
    await queryRunner.manager.query(
      `INSERT INTO "transaction"
         ("id", "type", "status", "amount", "currency", "debit_account_id",
          "credit_account_id", "payee_id", "initiated_by", "posted_at", "expires_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + interval '2 minutes')`,
      [
        id,
        data.type,
        data.status,
        data.amount,
        data.currency,
        data.debitAccountId ?? null,
        data.creditAccountId ?? null,
        data.payeeId ?? null,
        data.initiatedBy,
        data.postedAt ?? null,
      ],
    );

    const inserted = await this.findByIdInTx(queryRunner, id);
    if (!inserted) {
      // Unreachable: the row was just inserted under this same transaction.
      throw new Error(`Transaction ${id} vanished after its PENDING insert`);
    }
    return inserted;
  }

  findByIdInTx(queryRunner: QueryRunner, id: string): Promise<Transaction | null> {
    return queryRunner.manager.findOne(Transaction, { where: { id } });
  }

  findPendingByInitiator(initiatedBy: string): Promise<Transaction | null> {
    // The partial unique index guarantees ≤1 PENDING per initiator; `take: 1` + the ordering is
    // defensive so a (theoretically impossible) duplicate still resolves deterministically.
    return this.repo.findOne({
      where: { initiatedBy, status: TransactionStatus.Pending },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  findPendingByInitiatorInTx(
    queryRunner: QueryRunner,
    initiatedBy: string,
  ): Promise<Transaction | null> {
    // Same query as findPendingByInitiator, but via the queryRunner's manager so it participates
    // in (and sees) the caller's open transaction — external-outbound initiate reads the prior
    // pending here to release its hold before superseding it.
    return queryRunner.manager.findOne(Transaction, {
      where: { initiatedBy, status: TransactionStatus.Pending },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  async transitionToPostedInTx(queryRunner: QueryRunner, id: string): Promise<boolean> {
    // Guarded UPDATE: the WHERE status = PENDING predicate is the atomic gate. `now()` is the
    // DB clock (single source of truth). affected === 1 means THIS call won the transition;
    // 0 means the row was already posted / not pending.
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(Transaction)
      .set({ status: TransactionStatus.Posted, postedAt: () => 'now()' })
      .where('id = :id AND status = :pending', { id, pending: TransactionStatus.Pending })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async expireOverduePendingByInitiator(
    queryRunner: QueryRunner,
    initiatedBy: string,
  ): Promise<void> {
    // Flip every OVERDUE pending transfer for this initiator to EXPIRED, judged by the DB clock.
    // Guarded on status = PENDING so it never re-touches a terminal row; failure_reason stays
    // NULL (a lapse is not a failure), only the terminal timestamp is stamped.
    await queryRunner.manager
      .createQueryBuilder()
      .update(Transaction)
      .set({ status: TransactionStatus.Expired, failedAt: () => 'now()' })
      .where(
        'initiated_by = :initiatedBy AND status = :pending AND expires_at IS NOT NULL AND expires_at <= now()',
        { initiatedBy, pending: TransactionStatus.Pending },
      )
      .execute();
  }

  async supersedeActivePendingByInitiator(
    queryRunner: QueryRunner,
    initiatedBy: string,
  ): Promise<void> {
    // Auto-supersede the initiator's remaining ACTIVE pending (non-overdue by construction — the
    // expire sweep ran first) → CANCELLED, retained. Guarded on status = PENDING.
    await queryRunner.manager
      .createQueryBuilder()
      .update(Transaction)
      .set({
        status: TransactionStatus.Cancelled,
        failureReason: 'superseded',
        failedAt: () => 'now()',
      })
      .where('initiated_by = :initiatedBy AND status = :pending', {
        initiatedBy,
        pending: TransactionStatus.Pending,
      })
      .execute();
  }

  async expireIfOverdue(id: string): Promise<boolean> {
    // Single atomic guarded UPDATE: the row flips to EXPIRED iff it is STILL pending AND overdue
    // by the DB clock. affected > 0 means it WAS overdue (now EXPIRED); 0 means not overdue, or
    // already terminal (a concurrent transition).
    const result = await this.repo
      .createQueryBuilder()
      .update(Transaction)
      .set({ status: TransactionStatus.Expired, failedAt: () => 'now()' })
      .where('id = :id AND status = :pending AND expires_at IS NOT NULL AND expires_at <= now()', {
        id,
        pending: TransactionStatus.Pending,
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async expireIfOverdueInTx(queryRunner: QueryRunner, id: string): Promise<boolean> {
    // Same guarded, DB-clock expiry as expireIfOverdue, but via queryRunner.manager so it commits
    // (or rolls back) together with the external pending's hold release + held decrement.
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(Transaction)
      .set({ status: TransactionStatus.Expired, failedAt: () => 'now()' })
      .where('id = :id AND status = :pending AND expires_at IS NOT NULL AND expires_at <= now()', {
        id,
        pending: TransactionStatus.Pending,
      })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async transitionToCancelled(id: string): Promise<boolean> {
    // Guarded explicit cancel: PENDING → CANCELLED, retained. affected > 0 means THIS call
    // cancelled it; 0 means it was already terminal (concurrently posted / expired / cancelled).
    const result = await this.repo
      .createQueryBuilder()
      .update(Transaction)
      .set({
        status: TransactionStatus.Cancelled,
        failureReason: 'cancelled_by_user',
        failedAt: () => 'now()',
      })
      .where('id = :id AND status = :pending', { id, pending: TransactionStatus.Pending })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async transitionToCancelledInTx(queryRunner: QueryRunner, id: string): Promise<boolean> {
    // Same guarded cancel as transitionToCancelled, but via queryRunner.manager so it commits
    // (or rolls back) together with the external pending's hold release + held decrement.
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(Transaction)
      .set({
        status: TransactionStatus.Cancelled,
        failureReason: 'cancelled_by_user',
        failedAt: () => 'now()',
      })
      .where('id = :id AND status = :pending', { id, pending: TransactionStatus.Pending })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async transitionToReversedInTx(queryRunner: QueryRunner, id: string): Promise<boolean> {
    // Guarded UPDATE: the `status = POSTED` predicate is the atomic idempotency gate for the rail
    // FAILURE callback. affected === 1 means THIS call won the reversal (the caller then posts the
    // compensating movement); 0 means the row was already reversed / is not posted, so a retried
    // or concurrent failure callback is a no-op — no double reversal. `failure_reason` records WHY
    // the posted movement was reversed. There is no dedicated `reversed_at` column; the
    // compensating transaction (with its own `posted_at` + `reverses_transaction_id`) is the audit
    // record of when/what reversed it.
    const result = await queryRunner.manager
      .createQueryBuilder()
      .update(Transaction)
      .set({ status: TransactionStatus.Reversed, failureReason: 'rail_settlement_failed' })
      .where('id = :id AND status = :posted', { id, posted: TransactionStatus.Posted })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
