import type { AccountDto } from '../../services/api/contracts/accounts';

/**
 * Seed customer accounts for the MSW stub. `available` is precomputed here as
 * `balance - held` (minor units) to mirror the server serializer, where it is
 * derived at serialize time and never read from storage.
 */
export const fixtureAccounts: AccountDto[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    currency: 'MXN',
    status: 'active',
    kind: 'customer',
    balance: '1500000',
    held: '0',
    available: '1500000',
    accountNumber: '1000000001',
    label: 'Checking',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    currency: 'MXN',
    status: 'active',
    kind: 'customer',
    balance: '250075',
    held: '5000',
    available: '245075',
    accountNumber: '1000000002',
    label: 'Savings',
  },
];
