import { ExternalPayee } from '../../../../database/entities/external-payee.entity';
import { PayeeDto } from '../dto/payee.dto';

/**
 * The anti-leak transport boundary for the payees `/api` reads/writes: a pure serializer that
 * lists every output field EXPLICITLY and MUST NOT spread the entity — internal columns
 * (`ownerId`, `rail`, `status`, `activatedAt`) must never reach the wire. Adding a field is a
 * deliberate act.
 *
 * `coolingOffUntil` / `createdAt` render as ISO-8601 UTC instants. `usable` is a
 * presentation-derived hint (`now() >= coolingOffUntil`): a payee is a valid destination from
 * `cooling_off_until` onward. It is only a hint — the AUTHORITATIVE gate is date-checked against
 * the DB clock at outbound time (a later step), never trusted from this flag.
 */
export function serializePayee(payee: ExternalPayee): PayeeDto {
  return {
    id: payee.id,
    displayName: payee.displayName,
    destinationRef: payee.destinationRef,
    coolingOffUntil: payee.coolingOffUntil.toISOString(),
    usable: Date.now() >= payee.coolingOffUntil.getTime(),
    createdAt: payee.createdAt.toISOString(),
  };
}
