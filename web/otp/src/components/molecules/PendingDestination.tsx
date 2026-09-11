import type { PendingAuthorizationDto } from '../../services/api/contracts/pending-authorization';
import { DetailRow } from '../atoms/DetailRow';

/**
 * Renders the destination detail rows for a pending authorization, keyed off `type` — the
 * DTO's destination fields are mutually exclusive per type, so we read only the fields the
 * type defines (whitelist thinking; never render a field the shape says is null):
 * - `internal` → destination account number + masked holder name.
 * - `external_outbound` → the payee display name.
 * An unknown/future type shows a neutral placeholder rather than guessing at a field.
 */
export function PendingDestination({ authorization }: { authorization: PendingAuthorizationDto }) {
  if (authorization.type === 'internal') {
    return (
      <>
        <DetailRow label="To account">{authorization.destinationAccountNumber ?? '—'}</DetailRow>
        <DetailRow label="Recipient">{authorization.destinationMaskedName ?? '—'}</DetailRow>
      </>
    );
  }
  if (authorization.type === 'external_outbound') {
    return <DetailRow label="Payee">{authorization.payeeDisplayName ?? '—'}</DetailRow>;
  }
  return <DetailRow label="Destination">—</DetailRow>;
}
