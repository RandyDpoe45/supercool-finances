import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTransactionWithRetry } from '../../../../common/db/run-in-transaction';
import { UserLimitsScope } from '../../../../database/entities/enums';
import { UserLimits } from '../../../../database/entities/user-limits.entity';
import {
  IUserLimitsRepository,
  USER_LIMITS_REPOSITORY,
} from '../../../../database/repositories/interfaces/user-limits.repository.interface';
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICE,
  IAuditService,
} from '../../../audit/service/interfaces/audit.service.interface';
import { InvalidLimitsError } from '../errors';
import {
  ILimitsService,
  ListLimitsQuery,
  UpsertLimitsInput,
} from '../interfaces/limits.service.interface';

/** A compact before/after snapshot of the limits row for the audit metadata — the fields that
 * meaningfully change, not the whole entity (drops `id`/timestamps noise). `null` before-image
 * means the upsert created the row. */
function snapshot(row: UserLimits | null): Record<string, unknown> | null {
  if (!row) {
    return null;
  }
  return {
    scope: row.scope,
    ownerId: row.ownerId,
    currency: row.currency,
    perTransactionMax: row.perTransactionMax,
    dailyMax: row.dailyMax,
    monthlyMax: row.monthlyMax,
  };
}

/**
 * Admin limits configuration (spec 04 "Admin ops" — `PUT /limits`, single-actor). Validates the
 * scope/ownerId invariant, then in ONE transaction reads the before-image, upserts the row, and
 * writes ONE audit row (before/after) via {@link IAuditService.recordInTx} — the change and its
 * audit commit or roll back together. The rail-side enforcement (spec 04 step 7) reads these rows
 * at post/confirm time; this surface only CONFIGURES them.
 *
 * The method returns the plain {@link UserLimits} entity; DTO serialization is a transport concern
 * applied at the controller boundary.
 */
@Injectable()
export class LimitsService implements ILimitsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(USER_LIMITS_REPOSITORY) private readonly limits: IUserLimitsRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  async upsertLimits(actorId: string, input: UpsertLimitsInput): Promise<UserLimits> {
    const { scope, currency } = input;

    // Scope/ownerId invariant — a global row is owner-less; a customer override needs its owner.
    if (scope === 'global' && input.ownerId != null && input.ownerId !== '') {
      throw new InvalidLimitsError('A global limit must not carry an ownerId');
    }
    if (scope === 'customer' && (input.ownerId == null || input.ownerId === '')) {
      throw new InvalidLimitsError('A customer limit requires an ownerId');
    }

    const scopeEnum = scope === 'global' ? UserLimitsScope.Global : UserLimitsScope.Customer;
    const ownerId = scope === 'global' ? null : (input.ownerId as string);
    const perTransactionMax = input.perTransactionMax ?? null;
    const dailyMax = input.dailyMax ?? null;
    const monthlyMax = input.monthlyMax ?? null;

    return runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      const before = await this.limits.findExactInTx(queryRunner, scopeEnum, ownerId, currency);
      const after = await this.limits.upsertInTx(queryRunner, {
        scope: scopeEnum,
        ownerId,
        currency,
        perTransactionMax,
        dailyMax,
        monthlyMax,
      });
      await this.audit.recordInTx(queryRunner, {
        actorId,
        action: AUDIT_ACTIONS.LIMITS_CHANGE,
        targetType: 'user_limits',
        targetId: `${scope}:${ownerId ?? 'global'}`,
        metadata: { before: snapshot(before), after: snapshot(after) },
      });
      return after;
    });
  }

  /**
   * Admin `GET /admin/limits` — view ANY limits row (spec 04 "Admin ops"). Maps the optional wire
   * `scope` string to the {@link UserLimitsScope} enum, then delegates to the repository's
   * parameterized query. A pure READ (no audit, no tx). Returns entities; the controller serializes.
   */
  listLimits(query: ListLimitsQuery): Promise<UserLimits[]> {
    const scope =
      query.scope === undefined
        ? undefined
        : query.scope === 'global'
          ? UserLimitsScope.Global
          : UserLimitsScope.Customer;
    return this.limits.list({ scope, ownerId: query.ownerId });
  }
}
