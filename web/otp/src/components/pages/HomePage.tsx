import { instantToEpochMs } from '../../lib/datetime';
import { parseApiError } from '../../lib/apiError';
import { useCountdown } from '../../lib/useCountdown';
import { useGetPendingAuthorizationQuery } from '../../services/api/pendingAuthorizationApi';
import { Alert } from '../atoms/Alert';
import { CodeRevealPanel } from '../organisms/CodeRevealPanel';
import { PendingFeed } from '../organisms/PendingFeed';

/**
 * The otp-app home screen: the user's single pending authorization plus the code-reveal
 * action. Reveal is enabled only while there is a live pending — a live countdown to the
 * pending's expiry (via {@link useCountdown}) flips it off the moment the deadline lapses,
 * so an expired authorization can no longer mint a code.
 */
export function HomePage() {
  const { data, isLoading, isFetching, isError, error, refetch } =
    useGetPendingAuthorizationQuery();
  const authorization = data ?? null;

  // Hooks run before any early return (rules-of-hooks); a null deadline just yields 0.
  const expiresAtMs = authorization ? instantToEpochMs(authorization.expiresAt) : null;
  const secondsLeft = useCountdown(expiresAtMs);
  const expired = expiresAtMs !== null && secondsLeft <= 0;

  if (isLoading) {
    return <p>Loading pending authorization…</p>;
  }
  if (isError) {
    return (
      <Alert variant="error">
        Failed to load your pending authorization ({describeLoadError(error)}). Try refreshing.
      </Alert>
    );
  }

  const revealDisabledReason =
    authorization === null
      ? 'There is no pending authorization, so there is nothing to authorize right now.'
      : expired
        ? 'This authorization has expired. Start the transfer again in the SuperCool app.'
        : null;

  return (
    <div className="home">
      <PendingFeed
        authorization={authorization}
        isFetching={isFetching}
        onRefresh={() => void refetch()}
      />
      <CodeRevealPanel disabledReason={revealDisabledReason} />
    </div>
  );
}

function describeLoadError(error: unknown): string {
  const parsed = parseApiError(error);
  if (parsed.status !== undefined) {
    return `HTTP ${parsed.status}`;
  }
  return 'unknown error';
}
