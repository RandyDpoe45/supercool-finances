/**
 * The single constant outbound rail id. The prototype clears ALL external outbound through one
 * mocked rail (never user-supplied), so its id is a system constant, not per-request data. It is
 * stored on `external_payee.rail` at enrollment and names the counter-leg clearing account —
 * `clearing:${OUTBOUND_RAIL}` — which the system seed provisions (`clearing:rail-outbound`). The
 * later holds/outbound step reuses this constant for the debit→clearing settlement leg.
 */
export const OUTBOUND_RAIL = 'rail-outbound';
