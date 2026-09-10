/**
 * Customer-facing view of an enrolled {@link ExternalPayee} on `POST /api/payees` and
 * `GET /api/payees`. An explicit wire contract — the serializer whitelists each field by hand and
 * never spreads the entity, so internal columns never leak: `ownerId`, `rail` (a system constant),
 * `status` and `activatedAt` (reserved & unused) are deliberately NOT exposed.
 *
 * `coolingOffUntil` / `createdAt` are ISO-8601 UTC strings. `usable` is a presentation-derived
 * hint (`now() >= coolingOffUntil`) computed at serialize time — the AUTHORITATIVE usability gate
 * is re-checked against the DB clock at outbound time (a later step), not trusted from this flag.
 */
export interface PayeeDto {
  id: string;
  displayName: string;
  destinationRef: string;
  coolingOffUntil: string;
  usable: boolean;
  createdAt: string;
}
