/**
 * Seed enrolled PAYEES for the MSW stub — external beneficiaries the signed-in user has enrolled.
 * The cooling-off instant is expressed as an OFFSET from "now" (resolved at seed time), so the
 * derived `usable` hint (`now >= coolingOffUntil`) is deterministic regardless of wall-clock: one
 * payee is already past its cooling-off (usable — the demo's external-transfer target) and one is
 * still cooling off (not usable — exercises the cooling-off UX + the authoritative-vs-hint gate).
 *
 * `destinationRef` is the external account number the owner supplied (a 6–20 digit numeric string,
 * mirroring the service's enrollment schema). The rail / status / ownerId are server-owned and never
 * appear here or on the wire.
 */
export interface PayeeFixture {
  id: string;
  displayName: string;
  destinationRef: string;
  /** Offset (ms) from seed-time "now" for `coolingOffUntil`. Negative ⇒ already usable. */
  coolingOffOffsetMs: number;
  /** Offset (ms) from seed-time "now" for `createdAt` (always in the past). */
  createdAtOffsetMs: number;
}

/** One day, matching the balance-service default `PAYEE_COOLING_OFF_SECONDS` (86400). */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const fixturePayees: readonly PayeeFixture[] = [
  {
    id: 'aaaa1111-0000-4000-8000-0000000000a1',
    displayName: 'Landlord',
    destinationRef: '4000000001',
    // Enrolled two days ago; cooling-off lapsed a day ago ⇒ usable now.
    coolingOffOffsetMs: -ONE_DAY_MS,
    createdAtOffsetMs: -2 * ONE_DAY_MS,
  },
  {
    id: 'bbbb2222-0000-4000-8000-0000000000b2',
    displayName: 'New Supplier',
    destinationRef: '5000000002',
    // Just enrolled; still cooling off for ~a day ⇒ not usable yet.
    coolingOffOffsetMs: ONE_DAY_MS,
    createdAtOffsetMs: -60 * 1000,
  },
];
