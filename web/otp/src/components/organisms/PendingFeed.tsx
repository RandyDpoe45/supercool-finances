import { formatInstant, instantToEpochMs } from '../../lib/datetime';
import { formatMinorUnits } from '../../lib/money';
import type { PendingAuthorizationDto } from '../../services/api/contracts/pending-authorization';
import { Button } from '../atoms/Button';
import { Countdown } from '../atoms/Countdown';
import { DetailRow } from '../atoms/DetailRow';
import { PendingDestination } from '../molecules/PendingDestination';

/** Human labels for the transfer `type` (unknown types fall back to the raw code). */
const TRANSFER_TYPE_LABEL: Readonly<Record<string, string>> = {
  internal: 'Internal transfer',
  external_outbound: 'External transfer',
};

/**
 * The pending-authorization feed card: what the signed-in user is about to authorize. Shows
 * the FORMATTED amount + currency, the transfer type, the type-dependent destination, and
 * the request/expiry times in Mexico City time with a live countdown to the 2-minute
 * deadline. Renders a clear empty state when there is nothing pending, and always offers a
 * manual refresh.
 */
export function PendingFeed({
  authorization,
  isFetching,
  onRefresh,
}: {
  authorization: PendingAuthorizationDto | null;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="card" aria-label="pending-authorization">
      <header className="card__header">
        <h2 className="card__title">Pending authorization</h2>
        <Button
          variant="secondary"
          onClick={onRefresh}
          disabled={isFetching}
          aria-label="refresh-pending"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </header>
      {authorization === null ? (
        <p className="card__empty">
          No pending authorization right now. When you start a transfer in the SuperCool app, it
          will appear here to authorize.
        </p>
      ) : (
        <PendingDetails authorization={authorization} />
      )}
    </section>
  );
}

function PendingDetails({ authorization }: { authorization: PendingAuthorizationDto }) {
  const expiresAtMs = instantToEpochMs(authorization.expiresAt);
  const typeLabel = TRANSFER_TYPE_LABEL[authorization.type] ?? authorization.type;
  return (
    <>
      <p className="card__amount">
        {formatMinorUnits(authorization.amount, authorization.currency)} {authorization.currency}
      </p>
      <dl className="card__details">
        <DetailRow label="Type">{typeLabel}</DetailRow>
        <PendingDestination authorization={authorization} />
        <DetailRow label="Requested">{formatInstant(authorization.createdAt)}</DetailRow>
        <DetailRow label="Expires">
          <span>
            {authorization.expiresAt ? formatInstant(authorization.expiresAt) : 'No deadline'}
          </span>
          {expiresAtMs !== null ? (
            <span className="detail-row__countdown">
              {' ('}
              <Countdown deadlineMs={expiresAtMs} />
              {')'}
            </span>
          ) : null}
        </DetailRow>
      </dl>
    </>
  );
}
