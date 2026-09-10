/**
 * Seed transfer DESTINATIONS for the MSW stub — OTHER customers the signed-in user can pay
 * (distinct from the caller's own `fixtures/accounts.ts` numbers). `resolve-destination` looks a
 * 10-digit account number up here; an unknown number is a 404 (indistinguishable from a system /
 * non-existent account, anti-IDOR). `maskedName` mirrors the service's `maskName` rule — each name
 * token becomes its first 3 characters plus two asterisks (`"Juan Perez"` → `"Jua** Per**"`) — so
 * the stub never carries a raw holder name, exactly like the real serializer.
 */
export interface DestinationFixture {
  accountNumber: string;
  maskedName: string;
  currency: string;
}

export const fixtureDestinations: readonly DestinationFixture[] = [
  { accountNumber: '2000000001', maskedName: 'Mar** Góm**', currency: 'MXN' },
  { accountNumber: '2000000002', maskedName: 'Jua** Per**', currency: 'MXN' },
];
