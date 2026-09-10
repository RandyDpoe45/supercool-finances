/**
 * The single constant inbound rail id — the mirror of {@link OUTBOUND_RAIL}. The prototype
 * receives ALL external inbound through one mocked rail, so its id is a system constant, not
 * per-request data. It names the counter-leg clearing account — `clearing:${INBOUND_RAIL}`
 * (`clearing:rail-inbound`) — which the system seed provisions (`SeedSystemAccounts`). The
 * rail settlement/inbound webhook debits that clearing account when crediting a customer.
 */
export const INBOUND_RAIL = 'rail-inbound';
