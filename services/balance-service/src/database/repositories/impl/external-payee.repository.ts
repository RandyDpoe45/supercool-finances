import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { ExternalPayee } from '../../entities/external-payee.entity';
import { IExternalPayeeRepository } from '../interfaces/external-payee.repository.interface';

/** TypeORM implementation of {@link IExternalPayeeRepository}, bound to
 * `EXTERNAL_PAYEE_REPOSITORY` in {@link PersistenceModule}. */
@Injectable()
export class ExternalPayeeRepository implements IExternalPayeeRepository {
  constructor(@InjectRepository(ExternalPayee) private readonly repo: Repository<ExternalPayee>) {}

  findById(id: string): Promise<ExternalPayee | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<ExternalPayee>): Promise<ExternalPayee> {
    return this.repo.save(this.repo.create(data));
  }

  findByOwner(ownerId: string): Promise<ExternalPayee[]> {
    return this.repo.find({ where: { ownerId } });
  }

  async createEnrollment(
    ownerId: string,
    displayName: string,
    rail: string,
    destinationRef: string,
    coolingOffSeconds: number,
  ): Promise<ExternalPayee> {
    // `cooling_off_until` is stamped FROM THE DB CLOCK — `now() + make_interval(secs => $6)` — so
    // the usability gate is judged against the same clock everywhere (never the app clock). The
    // seconds value is the validated positive integer from config (NOT user input) and is BOUND as
    // a parameter like every other value — nothing is concatenated into the SQL. `status` (→ 'pending'),
    // `created_at` (→ now()) and `activated_at` (→ NULL) take their DB defaults — status/activated_at
    // are reserved for a future admin/self-disable flow, unused now. Presetting `id` means this can
    // only ever INSERT; the row is re-read so the returned entity carries the DB-generated columns.
    const id = randomUUID();
    await this.repo.query(
      `INSERT INTO "external_payee"
         ("id", "owner_id", "display_name", "rail", "destination_ref", "cooling_off_until")
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [id, ownerId, displayName, rail, destinationRef, coolingOffSeconds],
    );

    const inserted = await this.repo.findOne({ where: { id } });
    if (!inserted) {
      // Unreachable: the row was just inserted (auto-committed) under this same connection.
      throw new Error(`External payee ${id} vanished after its enrollment insert`);
    }
    return inserted;
  }
}
