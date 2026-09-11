import type { AdminTransactionDto } from '../../services/api/contracts/transaction';
import { OWNER_ONE, OWNER_TWO } from './accounts';

/** Account ids from `fixtures/accounts.ts` (kept as literals here to avoid coupling the two seed
 * files); the system/clearing account has no owner. */
const ACCOUNT_ONE = '11111111-1111-4111-8111-111111111111'; // OWNER_ONE
const ACCOUNT_TWO = '33333333-3333-4333-8333-333333333333'; // OWNER_TWO
const CLEARING = '44444444-4444-4444-8444-444444444444'; // system clearing

/** The checker admin who executed the seeded reversal (also the logged-in `fixtureWhoami.userId`). */
const CHECKER_ADMIN = 'admin-user-1';

/** Stable ids for the seeded transactions, referenced by the approvals fixtures + tests. */
export const TX_INTERNAL_POSTED = 'aa000000-0000-4000-8000-000000000001';
export const TX_INBOUND_POSTED = 'aa000000-0000-4000-8000-000000000002';
export const TX_OUTBOUND_POSTED = 'aa000000-0000-4000-8000-000000000003';
export const TX_INTERNAL_PENDING = 'aa000000-0000-4000-8000-000000000004';
export const TX_INTERNAL_REVERSED = 'aa000000-0000-4000-8000-000000000005';
export const TX_COMPENSATING = 'aa000000-0000-4000-8000-000000000006';

/**
 * Seed admin-visible transactions for the MSW stub, chosen to exercise every branch of the
 * reversibility rule (POSTED && internal|external_inbound):
 *
 * - a POSTED `internal` transfer — REVERSIBLE;
 * - a POSTED `external_inbound` credit — REVERSIBLE;
 * - a POSTED `external_outbound` payout — NOT reversible (its reversal is the rail-failure path);
 * - a PENDING `internal` transfer — NOT reversible (not POSTED);
 * - a REVERSED `internal` transfer (already reversed, `failureReason: 'admin_reversal'`) — NOT
 *   reversible;
 * - the COMPENSATING transaction for that reversal (`reversesTransactionId` → the reversed one, legs
 *   mirrored, initiated by the checker).
 *
 * `amount` is a minor-unit STRING (never a number); MXN throughout. `initiatedBy` is the owning
 * customer for customer-initiated movements (so the stub's best-effort `ownerId` filter has
 * something to match), the rail for inbound, and the checker admin for the compensating post.
 */
export const fixtureTransactions: AdminTransactionDto[] = [
  {
    id: TX_INTERNAL_POSTED,
    type: 'internal',
    status: 'POSTED',
    amount: '50000',
    currency: 'MXN',
    debitAccountId: ACCOUNT_ONE,
    creditAccountId: ACCOUNT_TWO,
    payeeId: null,
    reversesTransactionId: null,
    initiatedBy: OWNER_ONE,
    failureReason: null,
    createdAt: '2026-02-10T15:00:00.000Z',
    postedAt: '2026-02-10T15:00:01.000Z',
    failedAt: null,
    expiresAt: null,
  },
  {
    id: TX_INBOUND_POSTED,
    type: 'external_inbound',
    status: 'POSTED',
    amount: '120000',
    currency: 'MXN',
    debitAccountId: CLEARING,
    creditAccountId: ACCOUNT_TWO,
    payeeId: null,
    reversesTransactionId: null,
    initiatedBy: 'system-rail-inbound',
    failureReason: null,
    createdAt: '2026-02-11T09:30:00.000Z',
    postedAt: '2026-02-11T09:30:00.500Z',
    failedAt: null,
    expiresAt: null,
  },
  {
    id: TX_OUTBOUND_POSTED,
    type: 'external_outbound',
    status: 'POSTED',
    amount: '75000',
    currency: 'MXN',
    debitAccountId: ACCOUNT_ONE,
    creditAccountId: CLEARING,
    payeeId: 'cc000000-0000-4000-8000-000000000c01',
    reversesTransactionId: null,
    initiatedBy: OWNER_ONE,
    failureReason: null,
    createdAt: '2026-02-12T18:45:00.000Z',
    postedAt: '2026-02-12T18:45:02.000Z',
    failedAt: null,
    expiresAt: null,
  },
  {
    id: TX_INTERNAL_PENDING,
    type: 'internal',
    status: 'PENDING',
    amount: '30000',
    currency: 'MXN',
    debitAccountId: ACCOUNT_ONE,
    creditAccountId: ACCOUNT_TWO,
    payeeId: null,
    reversesTransactionId: null,
    initiatedBy: OWNER_ONE,
    failureReason: null,
    createdAt: '2026-02-13T11:20:00.000Z',
    postedAt: null,
    failedAt: null,
    expiresAt: '2026-02-13T11:25:00.000Z',
  },
  {
    id: TX_INTERNAL_REVERSED,
    type: 'internal',
    status: 'REVERSED',
    amount: '90000',
    currency: 'MXN',
    debitAccountId: ACCOUNT_TWO,
    creditAccountId: ACCOUNT_ONE,
    payeeId: null,
    reversesTransactionId: null,
    initiatedBy: OWNER_TWO,
    failureReason: 'admin_reversal',
    createdAt: '2026-02-09T10:00:00.000Z',
    postedAt: '2026-02-09T10:00:01.000Z',
    failedAt: null,
    expiresAt: null,
  },
  {
    id: TX_COMPENSATING,
    type: 'internal',
    status: 'POSTED',
    amount: '90000',
    currency: 'MXN',
    // Mirrored legs of TX_INTERNAL_REVERSED (debit ACCOUNT_TWO / credit ACCOUNT_ONE): the
    // compensating post debits the original credit account and credits the original debit account.
    debitAccountId: ACCOUNT_ONE,
    creditAccountId: ACCOUNT_TWO,
    payeeId: null,
    reversesTransactionId: TX_INTERNAL_REVERSED,
    initiatedBy: CHECKER_ADMIN,
    failureReason: null,
    createdAt: '2026-02-09T12:30:00.000Z',
    postedAt: '2026-02-09T12:30:00.500Z',
    failedAt: null,
    expiresAt: null,
  },
];
