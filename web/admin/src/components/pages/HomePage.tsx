import { parseApiError } from '../../lib/apiError';
import { useGetWhoamiQuery } from '../../services/api/identityApi';
import { Alert } from '../atoms/Alert';

/**
 * The admin-plane landing screen and the Step-1 auth-shell proof: it calls
 * `GET /balance/admin/whoami` and renders the returned identity (`userId` + `roles`). A
 * successful render confirms the full spine — PKCE token → RTK Query bearer → gateway →
 * admin surface — round-trips. The dashboard screens (account management, reversals,
 * audit, analytics) build on this in later steps.
 */
export function HomePage() {
  const { data, isLoading, isError, error } = useGetWhoamiQuery();

  if (isLoading) {
    return <p>Loading…</p>;
  }
  if (isError || !data) {
    return (
      <Alert variant="error">
        Failed to load your admin identity ({describeLoadError(error)}). Try refreshing.
      </Alert>
    );
  }

  return (
    <div className="home">
      <h1>Admin console</h1>
      <p>Signed in to the admin plane. Your identity as resolved by the gateway:</p>
      <dl className="identity">
        <div className="detail-row">
          <dt className="detail-row__label">User ID</dt>
          <dd className="detail-row__value">{data.userId}</dd>
        </div>
        <div className="detail-row">
          <dt className="detail-row__label">Roles</dt>
          <dd className="detail-row__value">
            {data.roles.length > 0 ? data.roles.join(', ') : '(none)'}
          </dd>
        </div>
      </dl>
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
