/**
 * The acknowledgement the `/external` rail webhooks return. Deliberately MINIMAL — a third-party
 * caller gets only a fixed `status` marker plus the transaction id it can correlate on. NO PII,
 * NO customer/account details, NO internal transfer fields ever cross this boundary.
 *
 * - settlement callback → `transactionId` is the ORIGINAL outbound transfer id the rail sent.
 * - inbound credit → `transactionId` is the newly-posted (or replayed) `external_inbound` id.
 */
export interface RailAckDto {
  /** A fixed acknowledgement marker (`'ok'`) — NOT the transaction's status. */
  status: string;
  transactionId: string;
}
