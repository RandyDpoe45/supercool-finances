import { QueryRunner } from 'typeorm';
import { AuditLog } from '../../../../database/entities/audit-log.entity';

/** DI token for {@link IAuditService}. Consumers depend on the interface via this token, never
 * the concrete class. */
export const AUDIT_SERVICE = Symbol('AUDIT_SERVICE');

/**
 * The stable set of admin-action `action` strings written to the audit log. Kept here — beside
 * the service contract — so every producer (accounts freeze/unfreeze, limits change, simulated
 * inbound) names an action from ONE list and no free-form string drifts in. The `<domain>.<verb>`
 * convention mirrors the ledger/system-key naming.
 */
export const AUDIT_ACTIONS = {
  ACCOUNT_FREEZE: 'account.freeze',
  ACCOUNT_UNFREEZE: 'account.unfreeze',
  LIMITS_CHANGE: 'limits.change',
  EXTERNAL_INBOUND_SIMULATED: 'external.inbound.simulated',
  // Maker-checker reversals (step 8b): a maker proposes, a different checker executes or rejects.
  REVERSAL_PROPOSED: 'reversal.proposed',
  REVERSAL_EXECUTED: 'reversal.executed',
  REVERSAL_REJECTED: 'reversal.rejected',
} as const;

/**
 * One audit-log record: WHO did WHAT to WHICH target, with a free-form before/after `metadata`
 * blob. `actorId` is the admin's trusted gateway identity (`X-User-Id`). `(targetType, targetId)`
 * is a polymorphic, intentionally-not-FK pointer to the affected resource.
 */
export interface AuditEntry {
  actorId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** The admin audit-log query ({@link IAuditService.listAudit}, `GET /admin/audit`). Every field is
 * optional; each present filter is an EXACT-match predicate. `limit` / `offset` are the caller's
 * requested paging and are CLAMPED by the service (default 50, max 200, offset ≥ 0). */
export interface ListAuditQuery {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  offset?: number;
}

/**
 * The cross-cutting audit service (spec 04 "Admin ops": every mutating admin action writes the
 * audit log). Two write paths, chosen by whether the money/state change shares a transaction with
 * the audit row:
 *
 * - {@link recordInTx} — insert the audit row INSIDE the caller's transaction, so a freeze /
 *   unfreeze / limits change and its audit row commit (or roll back) together. This is the
 *   transactional path used by mutating admin ops.
 * - {@link record} — insert the audit row in its OWN transaction, for an action whose money
 *   movement already committed in a DIFFERENT service's transaction (e.g. the admin-triggered
 *   simulated inbound: the credit commits in the rails service's tx, idempotently by `externalRef`,
 *   then the admin surface records the audit after).
 */
export interface IAuditService {
  /** Insert one audit row inside the caller's active transaction (`queryRunner`). */
  recordInTx(queryRunner: QueryRunner, entry: AuditEntry): Promise<void>;
  /** Insert one audit row in its own auto-commit transaction. */
  record(entry: AuditEntry): Promise<void>;
  /**
   * Admin `GET /admin/audit` — browse the audit log (spec 04 "Admin ops"). The READ companion to the
   * write paths above: it is DELIBERATELY NOT owner-scoped (the audit log records privileged admin
   * actions, which have no customer owner — the role-gated admin surface sees them all). Applies each
   * present filter as an exact match, CLAMPS the requested paging (default 50, max 200, offset ≥ 0 —
   * never an unbounded scan), and delegates to the parameterized repository query. A pure READ — it
   * writes NO audit row and opens NO transaction. Returns entities newest-first; the controller
   * serializes them.
   */
  listAudit(query: ListAuditQuery): Promise<AuditLog[]>;
}
