import type { LimitsDto } from '../../services/api/contracts/limits';
import { OWNER_ONE } from './accounts';

/**
 * Seed limits for the MSW stub: the GLOBAL baseline (`ownerId: null`) plus one per-customer OVERRIDE
 * for `OWNER_ONE`. Caps are UNSIGNED minor-unit integer STRINGS (never numbers) or `null` (uncapped)
 * — e.g. `'5000000'` = 50,000.00 MXN. Enough to render the baseline-plus-overrides table and to
 * exercise upsert (update the baseline, add/replace an override).
 */
export const fixtureLimits: LimitsDto[] = [
  {
    id: 'aaaaaaaa-0000-4000-8000-00000000000a',
    scope: 'global',
    ownerId: null,
    currency: 'MXN',
    perTransactionMax: '5000000',
    dailyMax: '10000000',
    monthlyMax: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'bbbbbbbb-0000-4000-8000-00000000000b',
    scope: 'customer',
    ownerId: OWNER_ONE,
    currency: 'MXN',
    perTransactionMax: '150000',
    dailyMax: null,
    monthlyMax: '2000000',
    createdAt: '2026-01-07T12:00:00.000Z',
    updatedAt: '2026-01-07T12:00:00.000Z',
  },
];
