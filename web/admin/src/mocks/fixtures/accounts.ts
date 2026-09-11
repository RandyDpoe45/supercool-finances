import type { AdminAccountDto } from '../../services/api/contracts/account';

/** Two seed customer owners (a third-party subject id shape) plus a null-owner system account. */
export const OWNER_ONE = '00000000-0000-4000-8000-0000000000a1';
export const OWNER_TWO = '00000000-0000-4000-8000-0000000000a2';

/**
 * Seed admin-visible accounts for the MSW stub. A mix of `active` / `frozen`, an owner with TWO
 * accounts (`OWNER_ONE`), a second single-account owner (`OWNER_TWO`), and a null-owner `system`
 * clearing account — enough to exercise owner filtering and freeze/unfreeze. `available` is
 * precomputed here as `balance - held` (minor units) to mirror the server serializer, where it is
 * derived at serialize time and never stored. Money values are minor-unit STRINGS (never numbers).
 */
export const fixtureAccounts: AdminAccountDto[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: OWNER_ONE,
    kind: 'customer',
    currency: 'MXN',
    status: 'active',
    balance: '1500000',
    held: '0',
    available: '1500000',
    accountNumber: '1000000001',
    createdAt: '2026-01-05T14:30:00.000Z',
    updatedAt: '2026-01-05T14:30:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    ownerId: OWNER_ONE,
    kind: 'customer',
    currency: 'MXN',
    status: 'frozen',
    balance: '250075',
    held: '5000',
    available: '245075',
    accountNumber: '1000000002',
    createdAt: '2026-01-06T09:15:00.000Z',
    updatedAt: '2026-02-01T18:45:00.000Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    ownerId: OWNER_TWO,
    kind: 'customer',
    currency: 'MXN',
    status: 'active',
    balance: '900000',
    held: '0',
    available: '900000',
    accountNumber: '1000000003',
    createdAt: '2026-01-10T11:00:00.000Z',
    updatedAt: '2026-01-10T11:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    ownerId: null,
    kind: 'system',
    currency: 'MXN',
    status: 'active',
    balance: '0',
    held: '0',
    available: '0',
    accountNumber: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];
