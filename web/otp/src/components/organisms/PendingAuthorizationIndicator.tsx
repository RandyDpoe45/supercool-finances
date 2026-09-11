import type { PendingAuthorizationDto } from '../../services/api/contracts/pending-authorization';

/**
 * Bare, unstyled O1 smoke view: it reports only WHETHER the caller has a pending
 * authorization ("1 pending authorization" vs "No pending authorizations") to prove
 * the data pipe end to end — PKCE token -> RTK Query bearer -> `/api/pending-authorization`
 * stub -> render. It deliberately does NOT format the amount/dates or reveal any code;
 * the real pending feed + code reveal (with this app's OWN money/datetime helpers,
 * copied per ADR-16) land in O2.
 */
export function PendingAuthorizationIndicator({
  authorization,
}: {
  authorization: PendingAuthorizationDto | null;
}) {
  if (authorization === null) {
    return <p aria-label="pending-authorization">No pending authorizations</p>;
  }
  return <p aria-label="pending-authorization">1 pending authorization</p>;
}
