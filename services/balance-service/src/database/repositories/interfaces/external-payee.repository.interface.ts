import { DeepPartial } from 'typeorm';
import { ExternalPayee } from '../../entities/external-payee.entity';

/** DI token for {@link IExternalPayeeRepository}. */
export const EXTERNAL_PAYEE_REPOSITORY = Symbol('EXTERNAL_PAYEE_REPOSITORY');

/** Persistence port for {@link ExternalPayee} (owner-scoped). */
export interface IExternalPayeeRepository {
  findById(id: string): Promise<ExternalPayee | null>;
  create(data: DeepPartial<ExternalPayee>): Promise<ExternalPayee>;
  /** All payees enrolled by a customer (`owner_id`). */
  findByOwner(ownerId: string): Promise<ExternalPayee[]>;
  /**
   * Enroll a payee, stamping `cooling_off_until` from the **DB clock**
   * (`now() + make_interval(secs => coolingOffSeconds)`) so usability is judged against the same
   * clock everywhere — never the app clock. `status` / `created_at` / `activated_at` keep their
   * DB defaults (`pending` / `now()` / `NULL`; `status`/`activated_at` are reserved and unused).
   * `coolingOffSeconds` is a validated positive integer from config (never user input). A duplicate
   * `(owner_id, rail, destination_ref)` raises the `uq_payee` unique violation (SQLSTATE 23505),
   * which the service maps to a domain conflict. Returns the freshly inserted, re-selected row.
   */
  createEnrollment(
    ownerId: string,
    displayName: string,
    rail: string,
    destinationRef: string,
    coolingOffSeconds: number,
  ): Promise<ExternalPayee>;
}
