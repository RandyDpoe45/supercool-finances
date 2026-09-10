import type { PayeeDto } from '../../services/api/contracts/payees';
import { fixturePayees } from '../fixtures/payees';

/**
 * In-memory PAYEE state for the MSW stub, mirroring the balance-service enrollment closely enough to
 * exercise the client flow WITHOUT a backend: minimal enrollment (`displayName` + `destinationRef`;
 * the rail is a server-side constant, never accepted), a duplicate `destinationRef` colliding as
 * `PAYEE_ALREADY_ENROLLED` (mirroring the `uq_payee` unique index → 409), and date-gated usability —
 * enrollment stamps `coolingOffUntil = now + PAYEE_COOLING_OFF_MS` and `usable` is derived at read
 * time (`now >= coolingOffUntil`), matching the serializer's presentation hint.
 *
 * State lives at module scope; `resetPayeeStore()` reseeds it (one usable + one still-cooling payee)
 * so a test starts from a known slate. The stub has a single implicit caller, so `ownerId` is not
 * modeled — every payee belongs to that caller.
 */

/** New-enrollment cooling-off window, matching the balance-service default (86400 seconds). */
export const PAYEE_COOLING_OFF_MS = 24 * 60 * 60 * 1000;

interface StoredPayee {
  id: string;
  displayName: string;
  destinationRef: string;
  coolingOffUntil: Date;
  createdAt: Date;
}

function seededPayees(): StoredPayee[] {
  const now = Date.now();
  return fixturePayees.map((fixture) => ({
    id: fixture.id,
    displayName: fixture.displayName,
    destinationRef: fixture.destinationRef,
    coolingOffUntil: new Date(now + fixture.coolingOffOffsetMs),
    createdAt: new Date(now + fixture.createdAtOffsetMs),
  }));
}

let payees: StoredPayee[] = seededPayees();

/** Reset (reseed) all payee state — for test isolation. */
export function resetPayeeStore(): void {
  payees = seededPayees();
}

/** Serialize a stored payee to the wire DTO, whitelisting each field and deriving the `usable` hint
 * at read time (`now >= coolingOffUntil`) exactly like the service serializer. Internal columns
 * (ownerId, rail, status, activatedAt) are never modeled, so they can never leak. */
export function serializePayeeDto(payee: StoredPayee): PayeeDto {
  return {
    id: payee.id,
    displayName: payee.displayName,
    destinationRef: payee.destinationRef,
    coolingOffUntil: payee.coolingOffUntil.toISOString(),
    usable: Date.now() >= payee.coolingOffUntil.getTime(),
    createdAt: payee.createdAt.toISOString(),
  };
}

/** The caller's enrolled payees (insertion order). */
export function listPayees(): StoredPayee[] {
  return payees;
}

/** Look up an enrolled payee by id, or `undefined`. */
export function findPayee(id: string): StoredPayee | undefined {
  return payees.find((payee) => payee.id === id);
}

/** True iff the payee is past its cooling-off window on the CURRENT clock (the authoritative gate the
 * stub applies at send time; the DTO's `usable` is only a hint). */
export function isPayeeUsable(payee: StoredPayee): boolean {
  return Date.now() >= payee.coolingOffUntil.getTime();
}

export type RegisterPayeeResult =
  { outcome: 'created'; payee: StoredPayee } | { outcome: 'already-enrolled' };

/** Enroll a payee, stamping a fresh cooling-off window. A duplicate `destinationRef` collides (like
 * the service's `uq_payee`) → `already-enrolled` (409 PAYEE_ALREADY_ENROLLED). */
export function registerPayee(params: {
  displayName: string;
  destinationRef: string;
}): RegisterPayeeResult {
  if (payees.some((payee) => payee.destinationRef === params.destinationRef)) {
    return { outcome: 'already-enrolled' };
  }
  const now = Date.now();
  const payee: StoredPayee = {
    id: crypto.randomUUID(),
    displayName: params.displayName,
    destinationRef: params.destinationRef,
    coolingOffUntil: new Date(now + PAYEE_COOLING_OFF_MS),
    createdAt: new Date(now),
  };
  payees.push(payee);
  return { outcome: 'created', payee };
}
