import { Inject, Injectable } from '@nestjs/common';
import { OUTBOUND_RAIL } from '../../../../common/rails/outbound-rail';
import { APP_CONFIG } from '../../../../config/config.tokens';
import { AppConfig } from '../../../../config/configuration';
import { ExternalPayee } from '../../../../database/entities/external-payee.entity';
import {
  EXTERNAL_PAYEE_REPOSITORY,
  IExternalPayeeRepository,
} from '../../../../database/repositories/interfaces/external-payee.repository.interface';
import { PayeeAlreadyEnrolledError } from '../errors';
import { IPayeesService, RegisterPayeeParams } from '../interfaces/payees.service.interface';

/** The `uq_payee` unique index — `(owner_id, rail, destination_ref)` — a duplicate enrollment
 * collides on it (SQLSTATE 23505); the service maps that to a 409. */
const PAYEE_UNIQUE_CONSTRAINT = 'uq_payee';

/** True iff the error is (or wraps) a Postgres unique violation on {@link PAYEE_UNIQUE_CONSTRAINT}.
 * TypeORM surfaces the driver error as `QueryFailedError`; the SQLSTATE + constraint live on the
 * error or its `driverError`, so both are checked (mirrors the transfers single-pending helper). */
function isPayeeUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    driverError?: { code?: unknown; constraint?: unknown };
  };
  const code = candidate.code ?? candidate.driverError?.code;
  const constraint = candidate.constraint ?? candidate.driverError?.constraint;
  return code === '23505' && constraint === PAYEE_UNIQUE_CONSTRAINT;
}

/**
 * External-payee enrollment (spec 04 "External payees"). Enrollment is minimal and NOT money
 * movement: it records a beneficiary with a DB-clock `cooling_off_until` and returns it. Usability
 * is date-gated (`now() >= cooling_off_until`), never status-driven — there is NO status lifecycle
 * here (the entity's `status`/`activated_at` are reserved and left at their DB defaults). The
 * outbound rail is a CONSTANT ({@link OUTBOUND_RAIL}), never taken from the request.
 *
 * The methods return the plain {@link ExternalPayee} entity; DTO serialization is a transport
 * concern applied at the controller boundary (layering rule).
 */
@Injectable()
export class PayeesService implements IPayeesService {
  constructor(
    @Inject(EXTERNAL_PAYEE_REPOSITORY) private readonly payees: IExternalPayeeRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async registerPayee(params: RegisterPayeeParams): Promise<ExternalPayee> {
    const { ownerId, displayName, destinationRef } = params;
    try {
      // The rail is the single constant outbound rail (not user-supplied). Cooling-off is stamped
      // on the DB clock inside the repository from the env-configured window.
      return await this.payees.createEnrollment(
        ownerId,
        displayName,
        OUTBOUND_RAIL,
        destinationRef,
        this.config.payees.coolingOffSeconds,
      );
    } catch (error) {
      if (isPayeeUniqueViolation(error)) {
        throw new PayeeAlreadyEnrolledError();
      }
      throw error;
    }
  }

  listPayees(ownerId: string): Promise<ExternalPayee[]> {
    return this.payees.findByOwner(ownerId);
  }
}
