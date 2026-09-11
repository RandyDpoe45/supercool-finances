import type { AuditLogDto } from '../../services/api/contracts/audit';
import { OWNER_ONE } from './accounts';
import {
  APPROVAL_EXECUTED,
  APPROVAL_PENDING,
  APPROVAL_REJECTED,
  OTHER_MAKER_ID,
} from './approvals';
import { fixtureWhoami } from './identity';
import { TX_COMPENSATING, TX_INBOUND_POSTED, TX_INTERNAL_POSTED } from './transactions';

/** The two admins that appear as actors: the logged-in admin (`fixtureWhoami.userId`) and the second
 * admin from the approvals fixture — so the log shows more than one actor and the actor filter has
 * something to distinguish. */
const ADMIN_ONE = fixtureWhoami.userId; // admin-user-1
const ADMIN_TWO = OTHER_MAKER_ID; // admin-user-2

/** Account ids from `fixtures/accounts.ts`, kept as literals here to avoid coupling the seed files
 * (mirroring `fixtures/transactions.ts`); the system/clearing account is not a target below. */
const ACCOUNT_ONE = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_TWO = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_THREE = '33333333-3333-4333-8333-333333333333';

/** A SECOND (historical) reversal chain — a proposal → rejection whose approval is NOT in the current
 * approvals fixture. The audit log is append-only history, so it legitimately references ids that are
 * no longer (or never were) in live state. */
const HIST_APPROVAL_A = 'bb000000-0000-4000-8000-0000000000f2';
const HIST_APPROVAL_B = 'bb000000-0000-4000-8000-0000000000f3';
const HIST_REVERSAL_TX = 'aa000000-0000-4000-8000-0000000000fe';

/**
 * Seed admin audit-log entries for the MSW stub. Chosen to exercise the audit view end to end:
 *
 * - EVERY known `action` appears at least once (`account.freeze` / `account.unfreeze` /
 *   `limits.change` / `external.inbound.simulated` / `reversal.proposed` / `reversal.executed` /
 *   `reversal.rejected`);
 * - TWO distinct actors ({@link ADMIN_ONE} / {@link ADMIN_TWO}) so the actor filter is observable;
 * - varied `targetType` / `targetId` — `account`, `transaction`, `approval`, `limits`, and one entry
 *   with a NULL target (the columns are nullable; the current producer actions all bind a target, so
 *   this row is a deliberate null-branch fixture that also carries `null` metadata → the em-dash);
 * - realistic `metadata` before/after blobs. **Any money inside `metadata` is a minor-unit STRING**
 *   (e.g. `originalAmount: '90000'`, limit caps as strings) — never a number, never parsed to a float.
 *
 * `id` is an ascending bigint string (also the newest-first tiebreak sort key). `createdAt` is spread
 * across timestamps so newest-first ordering is observable; ids `'9'` and `'10'` DELIBERATELY share a
 * `createdAt` so the `createdAt DESC, then id DESC` tiebreak is exercised (`'10'` must precede `'9'` —
 * a numeric/bigint compare, not a lexicographic one).
 */
export const fixtureAudit: AuditLogDto[] = [
  {
    id: '1',
    actorId: ADMIN_ONE,
    action: 'account.freeze',
    targetType: 'account',
    targetId: ACCOUNT_TWO,
    metadata: { before: 'active', after: 'frozen' },
    createdAt: '2026-02-01T09:00:00.000Z',
  },
  {
    id: '2',
    actorId: ADMIN_TWO,
    action: 'account.unfreeze',
    targetType: 'account',
    targetId: ACCOUNT_TWO,
    metadata: { before: 'frozen', after: 'active' },
    createdAt: '2026-02-02T10:00:00.000Z',
  },
  {
    id: '3',
    actorId: ADMIN_ONE,
    action: 'limits.change',
    targetType: 'limits',
    targetId: 'global',
    metadata: { perTransactionMax: { before: '150000', after: '200000' } },
    createdAt: '2026-02-03T11:00:00.000Z',
  },
  {
    id: '4',
    actorId: ADMIN_TWO,
    action: 'external.inbound.simulated',
    targetType: 'account',
    targetId: ACCOUNT_THREE,
    metadata: { amount: '120000', currency: 'MXN', creditAccountId: ACCOUNT_THREE },
    createdAt: '2026-02-04T12:00:00.000Z',
  },
  {
    id: '5',
    actorId: ADMIN_TWO,
    action: 'reversal.proposed',
    targetType: 'transaction',
    targetId: TX_INTERNAL_POSTED,
    metadata: {
      approvalId: APPROVAL_PENDING,
      targetTransactionId: TX_INTERNAL_POSTED,
      reason: 'customer dispute',
    },
    createdAt: '2026-02-05T13:00:00.000Z',
  },
  {
    id: '6',
    actorId: ADMIN_ONE,
    action: 'reversal.executed',
    targetType: 'approval',
    targetId: APPROVAL_EXECUTED,
    metadata: {
      approvalId: APPROVAL_EXECUTED,
      reversalTransactionId: TX_COMPENSATING,
      originalAmount: '90000',
    },
    createdAt: '2026-02-06T14:00:00.000Z',
  },
  {
    id: '7',
    actorId: ADMIN_ONE,
    action: 'reversal.rejected',
    targetType: 'approval',
    targetId: APPROVAL_REJECTED,
    metadata: { approvalId: APPROVAL_REJECTED, reason: 'insufficient evidence' },
    createdAt: '2026-02-07T15:00:00.000Z',
  },
  {
    id: '8',
    actorId: ADMIN_TWO,
    action: 'account.freeze',
    targetType: 'account',
    targetId: ACCOUNT_THREE,
    metadata: { before: 'active', after: 'frozen' },
    createdAt: '2026-02-08T16:00:00.000Z',
  },
  {
    id: '9',
    actorId: ADMIN_ONE,
    action: 'limits.change',
    targetType: 'limits',
    targetId: OWNER_ONE,
    metadata: { dailyMax: { before: null, after: '500000' } },
    createdAt: '2026-02-09T17:00:00.000Z',
  },
  {
    // Shares `createdAt` with id '9' — the newest-first tiebreak must place '10' before '9' (id DESC).
    id: '10',
    actorId: ADMIN_TWO,
    action: 'account.unfreeze',
    targetType: 'account',
    targetId: ACCOUNT_THREE,
    metadata: { before: 'frozen', after: 'active' },
    createdAt: '2026-02-09T17:00:00.000Z',
  },
  {
    id: '11',
    actorId: ADMIN_ONE,
    action: 'external.inbound.simulated',
    targetType: 'account',
    targetId: ACCOUNT_ONE,
    metadata: { amount: '250000', currency: 'MXN', creditAccountId: ACCOUNT_ONE },
    createdAt: '2026-02-10T09:30:00.000Z',
  },
  {
    id: '12',
    actorId: ADMIN_TWO,
    action: 'reversal.proposed',
    targetType: 'transaction',
    targetId: TX_INBOUND_POSTED,
    metadata: {
      approvalId: HIST_APPROVAL_A,
      targetTransactionId: TX_INBOUND_POSTED,
      reason: 'duplicate inbound',
    },
    createdAt: '2026-02-11T08:00:00.000Z',
  },
  {
    id: '13',
    actorId: ADMIN_ONE,
    action: 'reversal.executed',
    targetType: 'approval',
    targetId: HIST_APPROVAL_A,
    metadata: {
      approvalId: HIST_APPROVAL_A,
      reversalTransactionId: HIST_REVERSAL_TX,
      // A minor-unit amount ABOVE Number.MAX_SAFE_INTEGER (2^53 = 9007199254740992). Kept as a
      // STRING end to end; the metadata renderer must show it verbatim. A `Number()`/`parseFloat`
      // regression would round it to ...992 and lose a centavo — the int64 money guarantee.
      originalAmount: '9007199254740993',
    },
    createdAt: '2026-02-12T18:00:00.000Z',
  },
  {
    id: '14',
    actorId: ADMIN_TWO,
    action: 'reversal.rejected',
    targetType: 'approval',
    targetId: HIST_APPROVAL_B,
    metadata: { approvalId: HIST_APPROVAL_B, reason: 'no evidence of error' },
    createdAt: '2026-02-13T07:45:00.000Z',
  },
  {
    id: '15',
    actorId: ADMIN_ONE,
    action: 'limits.change',
    targetType: 'limits',
    targetId: 'global',
    metadata: { monthlyMax: { before: '1000000', after: null } },
    createdAt: '2026-02-14T11:11:00.000Z',
  },
  {
    // Deliberate null-branch fixture: no target recorded and no metadata → the table renders an
    // em-dash for the target and a non-expandable "—" for the details.
    id: '16',
    actorId: ADMIN_TWO,
    action: 'external.inbound.simulated',
    targetType: null,
    targetId: null,
    metadata: null,
    createdAt: '2026-02-15T00:00:00.000Z',
  },
];
