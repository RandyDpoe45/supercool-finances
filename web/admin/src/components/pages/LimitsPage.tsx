import { describeApiError, parseApiError } from '../../lib/apiError';
import type { UpsertLimitsBody } from '../../services/api/contracts/limits';
import { useGetLimitsQuery, useUpsertLimitsMutation } from '../../services/api/limitsApi';
import { LimitsForm } from '../organisms/LimitsForm';
import { LimitsTable } from '../organisms/LimitsTable';

/**
 * Limits management (route `/limits`). Owns the limits read query (loading / error) and the upsert
 * mutation; the table renders the current global baseline + per-customer overrides and the form
 * edits them. The server's error envelope (e.g. `INVALID_LIMITS` when the scope⇒ownerId rule is
 * violated) is surfaced to the form as its `serverError` message.
 */
export function LimitsPage() {
  const { data: limits, isLoading, isError, error } = useGetLimitsQuery();
  const [upsert, upsertState] = useUpsertLimitsMutation();

  function handleSubmit(body: UpsertLimitsBody) {
    void upsert(body);
  }

  let serverError: string | undefined;
  if (upsertState.isError) {
    const parsed = parseApiError(upsertState.error);
    serverError =
      parsed.message ?? `Could not save limits (${describeApiError(upsertState.error)}).`;
  }

  return (
    <section>
      <h1>Limits</h1>

      <h2>Current limits</h2>
      {isLoading && <p>Loading…</p>}
      {isError && <p role="alert">Failed to load limits ({describeApiError(error)}).</p>}
      {!isLoading && !isError && <LimitsTable limits={limits ?? []} />}

      <h2>Set limits</h2>
      <LimitsForm
        onSubmit={handleSubmit}
        isSubmitting={upsertState.isLoading}
        serverError={serverError}
      />
    </section>
  );
}
