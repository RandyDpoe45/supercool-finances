import { useGetPendingAuthorizationQuery } from '../../services/api/pendingAuthorizationApi';
import { PendingAuthorizationIndicator } from '../organisms/PendingAuthorizationIndicator';

/**
 * O1 smoke screen. Proves the full spine: PKCE access token -> RTK Query bearer ->
 * MSW `/api/pending-authorization` stub -> render. Replaced by the real pending feed +
 * code reveal in O2.
 */
export function HomePage() {
  const { data, isLoading, isError, error } = useGetPendingAuthorizationQuery();

  if (isLoading) {
    return <p>Loading pending authorizations…</p>;
  }
  if (isError) {
    return <p role="alert">Failed to load pending authorizations ({describeError(error)}).</p>;
  }
  return <PendingAuthorizationIndicator authorization={data ?? null} />;
}

function describeError(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'status' in error) {
    return `HTTP ${String((error as { status: unknown }).status)}`;
  }
  return 'unknown error';
}
