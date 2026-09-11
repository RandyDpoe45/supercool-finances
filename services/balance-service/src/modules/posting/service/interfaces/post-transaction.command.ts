import { TransactionType } from '../../../../database/entities/enums';
import { TransactionEventPayee } from './transaction-event';

/**
 * One signed leg of a balancing post: a delta applied to a single account. `delta` is a
 * signed `bigint` minor-unit value carried as a `string` (int64 precision — never
 * `Number`/float): negative debits the account, positive credits it. Across a command the
 * legs must sum to zero (double-entry) and reference distinct accounts.
 */
export interface PostingLeg {
  accountId: string;
  delta: string;
}

/**
 * The input to {@link PostingService.postTransaction} — a fully-formed, balancing money
 * movement to apply atomically. This is a DOMAIN command (not a wire DTO): the transfers /
 * holds / admin layers build it and hand it to the single reducer that all balance
 * mutations funnel through.
 *
 * - `amount` is the positive magnitude of the movement in minor units (string), independent
 *   of the per-leg signs.
 * - `legs` are the signed deltas; their sum must be zero.
 * - `initiatedBy` is the actor recorded on the transaction header (a user `sub` or an
 *   admin/service identity).
 * - `payeeId` / `reversesTransactionId` are optional links (external payee, the transaction
 *   this one reverses); null when not applicable.
 * - `payee` is an OPTIONAL external-payee SNAPSHOT (id + display name + rail) copied verbatim
 *   onto the emitted transaction event so the analytics read model never joins back to
 *   `external_payee` (ADR-11). Set ONLY on the `external_outbound` confirm/settle path (whose
 *   caller already holds the payee entity); `null`/absent for internal transfers, inbound
 *   credits, and reversals. The reducer copies `payee ?? null` straight onto the event — it
 *   never itself reaches into a payee repository (that would break layering).
 * - `limitAccountId` opts this movement into limit enforcement — see the field doc.
 */
export interface PostTransactionCommand {
  type: TransactionType;
  currency: string;
  amount: string;
  legs: PostingLeg[];
  initiatedBy: string;
  payeeId?: string | null;
  payee?: TransactionEventPayee | null;
  reversesTransactionId?: string | null;
  /**
   * When set, the id of the CUSTOMER debit leg whose fixed-window spend this movement counts
   * against. The reducer resolves the applicable caps, lazily resets the window off the DB
   * clock, rejects with LIMIT_EXCEEDED if a cap would be breached, and increments
   * `spent_today`/`spent_month` — all under the same `FOR UPDATE` lock already taken for that
   * account (it must be one of the legs). Unset for movements that don't count against a
   * customer's spend (inbound credits, reversals).
   */
  limitAccountId?: string;
  /**
   * AUTHORITATIVE ADMIN CORRECTION ONLY (maker-checker reversal). When true, the reducer SKIPS
   * the frozen + insufficient-funds checks on customer DEBIT legs, so the movement always applies
   * and a customer balance may go negative. Still a balanced double-entry — no money is created or
   * lost. NEVER set on any customer-initiated path (it is set ONLY by `ApprovalService.approve`'s
   * compensating post, authorized by four-eyes).
   */
  forced?: boolean;
}
