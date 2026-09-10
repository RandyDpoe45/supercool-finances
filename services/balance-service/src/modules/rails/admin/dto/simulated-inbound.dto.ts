/**
 * Admin-plane view of the transaction posted by a SIMULATED external inbound
 * (`POST /admin/external/inbound`). The admin is a trusted, role-gated actor, so this exposes the
 * posted movement — the credited customer account leg, the amount/currency, and the timestamps.
 * Every field is listed EXPLICITLY (the serializer never spreads the entity); the debit
 * (`clearing:rail-inbound`) leg and internal columns are not surfaced.
 *
 * `amount` is a canonical `bigint` minor-unit string; timestamps are ISO-8601 UTC strings.
 */
export interface SimulatedInboundDto {
  transactionId: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  creditAccountId: string | null;
  createdAt: string;
  postedAt: string | null;
}
