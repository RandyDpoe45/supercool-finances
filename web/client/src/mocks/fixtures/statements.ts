import type { StatementEntryDto } from '../../services/api/contracts/accounts';

/**
 * Seed statements for the MSW stub, keyed by account id — mirroring
 * `GET /api/accounts/:id/transactions`. Entries are NEWEST-FIRST (server orders by
 * `created_at DESC, id DESC`) and `balanceAfter` is the running fold applied in
 * chronological order (so reading bottom-up the deltas accumulate to each `balanceAfter`).
 * Both directions appear (credit `delta > 0`, debit `delta < 0`) with non-zero minor-unit
 * amounts and realistic UTC (`Z`) timestamps. The final `balanceAfter` of each account
 * matches its `balance` in `fixtures/accounts.ts`.
 */
export const fixtureStatements: Readonly<Record<string, StatementEntryDto[]>> = {
  // Account 1 — balance 1,500,000 (15,000.00 MXN).
  '11111111-1111-4111-8111-111111111111': [
    {
      id: 'a1000004-0000-4000-8000-000000000004',
      transactionId: 'b1000004-0000-4000-8000-000000000004',
      delta: '-50000',
      balanceAfter: '1500000',
      currency: 'MXN',
      createdAt: '2026-09-08T22:10:03.000Z',
    },
    {
      id: 'a1000003-0000-4000-8000-000000000003',
      transactionId: 'b1000003-0000-4000-8000-000000000003',
      delta: '150000',
      balanceAfter: '1550000',
      currency: 'MXN',
      createdAt: '2026-09-02T14:20:45.000Z',
    },
    {
      id: 'a1000002-0000-4000-8000-000000000002',
      transactionId: 'b1000002-0000-4000-8000-000000000002',
      delta: '-600000',
      balanceAfter: '1400000',
      currency: 'MXN',
      createdAt: '2026-08-15T18:05:12.000Z',
    },
    {
      id: 'a1000001-0000-4000-8000-000000000001',
      transactionId: 'b1000001-0000-4000-8000-000000000001',
      delta: '2000000',
      balanceAfter: '2000000',
      currency: 'MXN',
      createdAt: '2026-08-01T15:30:00.000Z',
    },
  ],
  // Account 2 — balance 250,075 (2,500.75 MXN), held 5,000 (holds do not touch the ledger).
  '22222222-2222-4222-8222-222222222222': [
    {
      id: 'a2000003-0000-4000-8000-000000000003',
      transactionId: 'b2000003-0000-4000-8000-000000000003',
      delta: '10075',
      balanceAfter: '250075',
      currency: 'MXN',
      createdAt: '2026-09-07T16:15:00.000Z',
    },
    {
      id: 'a2000002-0000-4000-8000-000000000002',
      transactionId: 'b2000002-0000-4000-8000-000000000002',
      delta: '-60000',
      balanceAfter: '240000',
      currency: 'MXN',
      createdAt: '2026-08-20T09:45:30.000Z',
    },
    {
      id: 'a2000001-0000-4000-8000-000000000001',
      transactionId: 'b2000001-0000-4000-8000-000000000001',
      delta: '300000',
      balanceAfter: '300000',
      currency: 'MXN',
      createdAt: '2026-08-05T12:00:00.000Z',
    },
  ],
};
