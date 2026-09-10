/**
 * The confirmation-of-payee result on `POST /api/transfers/resolve-destination`. `maskedName`
 * is the destination holder's name masked by the service (e.g. `"Jua** Per**"`) — the raw name
 * (PII) never reaches the wire. `currency` is the destination account's currency. The
 * `confirmationToken` is single-use and bound to the caller; it MUST be presented to
 * `POST /api/transfers` to initiate — resolving alone is just a query, it moves no money.
 */
export interface ResolveDestinationDto {
  maskedName: string;
  currency: string;
  confirmationToken: string;
}
