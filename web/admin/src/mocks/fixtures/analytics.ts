import type { AccountSummaryDto, DailyAggregateDto } from '../../services/api/contracts/analytics';
import { OWNER_ONE, OWNER_TWO } from './accounts';

/**
 * Seed analytics read-model rows for the MSW stub, mirroring the analytics-server reporting VIEWs.
 * Reuses the two seed owners (`OWNER_ONE` / `OWNER_TWO`) and the account ids from `accounts.ts`
 * (as literals) so the analytics view lines up with the balance-side accounts, plus null-owner
 * SYSTEM accounts carrying a non-null `systemKey` (the shape only analytics surfaces).
 *
 * Money is a minor-unit STRING throughout — NEVER a number. At least one value in EACH report sits
 * ABOVE 2^53 (`9007199254740992`) to prove int64 precision survives the wire → render path (the
 * `Money` atom is float-free). `txnCount` / `count` are the only numerics (safe integers).
 * `lastActivityAt` is an ISO-8601 UTC instant; the daily-aggregate `date` is a `YYYY-MM-DD` UTC
 * day bucket LABEL (rendered verbatim, never timezone-converted).
 */
export const fixtureAccountSummaries: AccountSummaryDto[] = [
  {
    accountId: '11111111-1111-4111-8111-111111111111',
    ownerId: OWNER_ONE,
    accountKind: 'customer',
    systemKey: null,
    currency: 'MXN',
    lastBalanceAfter: '1500000',
    txnCount: 12,
    totalDebited: '300000',
    totalCredited: '1800000',
    lastActivityAt: '2026-03-06T15:04:00.000Z',
  },
  {
    accountId: '22222222-2222-4222-8222-222222222222',
    ownerId: OWNER_ONE,
    accountKind: 'customer',
    systemKey: null,
    currency: 'MXN',
    lastBalanceAfter: '245075',
    txnCount: 4,
    totalDebited: '54925',
    totalCredited: '300000',
    lastActivityAt: '2026-02-01T18:45:00.000Z',
  },
  {
    accountId: '33333333-3333-4333-8333-333333333333',
    ownerId: OWNER_TWO,
    accountKind: 'customer',
    systemKey: null,
    currency: 'MXN',
    lastBalanceAfter: '900000',
    txnCount: 7,
    totalDebited: '150000',
    totalCredited: '1050000',
    lastActivityAt: '2026-03-05T09:30:00.000Z',
  },
  {
    // System clearing account: null owner + a non-null `systemKey`. The three aggregates sit ABOVE
    // 2^53 to prove int64 precision survives — a `Number`/`parseFloat` here would silently corrupt.
    accountId: '44444444-4444-4444-8444-444444444444',
    ownerId: null,
    accountKind: 'system',
    systemKey: 'external_clearing',
    currency: 'MXN',
    lastBalanceAfter: '9007199254740993',
    txnCount: 210,
    totalDebited: '9223372036854775000',
    totalCredited: '9223372036854774000',
    lastActivityAt: '2026-03-06T23:59:59.000Z',
  },
  {
    accountId: '66666666-6666-4666-8666-666666666666',
    ownerId: null,
    accountKind: 'system',
    systemKey: 'fees',
    currency: 'MXN',
    lastBalanceAfter: '512300',
    txnCount: 33,
    totalDebited: '0',
    totalCredited: '512300',
    lastActivityAt: '2026-03-04T08:15:00.000Z',
  },
  {
    accountId: '55555555-5555-4555-8555-555555555555',
    ownerId: OWNER_TWO,
    accountKind: 'customer',
    systemKey: null,
    currency: 'USD',
    lastBalanceAfter: '75000',
    txnCount: 3,
    totalDebited: '25000',
    totalCredited: '100000',
    lastActivityAt: '2026-02-20T12:00:00.000Z',
  },
];

/**
 * Seed daily aggregates spread across several `date` buckets × `type` × `currency` so ordering and
 * inclusive `from`/`to` day filtering are observable. `totalAmount` is a minor-unit STRING; the
 * `2026-03-02 external_inbound` row sits ABOVE 2^53 to prove int64 precision survives. `count` is a
 * safe integer.
 */
export const fixtureDailyAggregates: DailyAggregateDto[] = [
  { date: '2026-03-06', currency: 'MXN', type: 'internal', count: 10, totalAmount: '980000' },
  {
    date: '2026-03-05',
    currency: 'MXN',
    type: 'external_inbound',
    count: 7,
    totalAmount: '1120000',
  },
  { date: '2026-03-05', currency: 'USD', type: 'internal', count: 2, totalAmount: '54000' },
  { date: '2026-03-04', currency: 'MXN', type: 'internal', count: 9, totalAmount: '720000' },
  {
    date: '2026-03-04',
    currency: 'MXN',
    type: 'external_outbound',
    count: 4,
    totalAmount: '260000',
  },
  { date: '2026-03-03', currency: 'MXN', type: 'internal', count: 11, totalAmount: '1230000' },
  {
    date: '2026-03-03',
    currency: 'USD',
    type: 'external_outbound',
    count: 1,
    totalAmount: '25000',
  },
  {
    date: '2026-03-02',
    currency: 'MXN',
    type: 'external_inbound',
    count: 2,
    totalAmount: '9007199254740993',
  },
  { date: '2026-03-02', currency: 'MXN', type: 'internal', count: 6, totalAmount: '410000' },
  { date: '2026-03-01', currency: 'MXN', type: 'internal', count: 8, totalAmount: '640000' },
  {
    date: '2026-03-01',
    currency: 'MXN',
    type: 'external_outbound',
    count: 3,
    totalAmount: '150000',
  },
  {
    date: '2026-03-01',
    currency: 'MXN',
    type: 'external_inbound',
    count: 5,
    totalAmount: '900000',
  },
];
