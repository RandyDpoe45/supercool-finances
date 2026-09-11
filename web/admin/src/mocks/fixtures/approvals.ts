import type { ApprovalRequestDto } from '../../services/api/contracts/approval';
import { fixtureWhoami } from './identity';
import { TX_INBOUND_POSTED, TX_INTERNAL_POSTED, TX_INTERNAL_REVERSED } from './transactions';

/**
 * A DIFFERENT admin from the logged-in one (`fixtureWhoami.userId`). The seeded PENDING reversal is
 * proposed by THIS maker, so the logged-in admin is a VALID checker (four-eyes: checker ≠ maker) and
 * can approve/reject it in the demo without tripping `SELF_APPROVAL_FORBIDDEN`.
 */
export const OTHER_MAKER_ID = 'admin-user-2';

/** Stable ids for the seeded approvals, referenced by tests. */
export const APPROVAL_PENDING = 'bb000000-0000-4000-8000-000000000001';
export const APPROVAL_EXECUTED = 'bb000000-0000-4000-8000-000000000002';
export const APPROVAL_REJECTED = 'bb000000-0000-4000-8000-000000000003';

/**
 * Seed maker-checker approvals for the MSW stub:
 *
 * - a PENDING reversal (the checker's queue) proposed by {@link OTHER_MAKER_ID} against the reversible
 *   POSTED internal transfer — so the logged-in admin can decide it (checker ≠ maker), and so a fresh
 *   propose of THAT target trips the duplicate guard (`REVERSAL_ALREADY_REQUESTED`);
 * - an EXECUTED reversal (target = the already-reversed transaction, checker = the logged-in admin) —
 *   the completed maker-checker flow, for the `status=EXECUTED` filter;
 * - a REJECTED reversal (target = the inbound credit) — a proposal the checker declined, for the
 *   `status=REJECTED` filter (a rejected target is still re-proposable).
 *
 * Timestamps are ISO-8601 UTC; `checkerId` / `decidedAt` / `executedAt` are null while PENDING.
 */
export const fixtureApprovals: ApprovalRequestDto[] = [
  {
    id: APPROVAL_PENDING,
    actionType: 'reversal',
    status: 'PENDING',
    makerId: OTHER_MAKER_ID,
    checkerId: null,
    targetTransactionId: TX_INTERNAL_POSTED,
    createdAt: '2026-02-14T08:00:00.000Z',
    decidedAt: null,
    executedAt: null,
  },
  {
    id: APPROVAL_EXECUTED,
    actionType: 'reversal',
    status: 'EXECUTED',
    makerId: OTHER_MAKER_ID,
    checkerId: fixtureWhoami.userId,
    targetTransactionId: TX_INTERNAL_REVERSED,
    createdAt: '2026-02-09T11:00:00.000Z',
    decidedAt: '2026-02-09T12:30:00.000Z',
    executedAt: '2026-02-09T12:30:00.500Z',
  },
  {
    id: APPROVAL_REJECTED,
    actionType: 'reversal',
    status: 'REJECTED',
    makerId: OTHER_MAKER_ID,
    checkerId: fixtureWhoami.userId,
    targetTransactionId: TX_INBOUND_POSTED,
    createdAt: '2026-02-12T07:15:00.000Z',
    decidedAt: '2026-02-12T07:45:00.000Z',
    executedAt: null,
  },
];
