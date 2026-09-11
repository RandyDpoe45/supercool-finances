import { baseApi } from './baseApi';
import type { AuditLogDto, AuditLogResponse } from './contracts/audit';

/** Optional filters for `GET /admin/audit`, mirroring the service's query schema. `actorId` /
 * `action` / `targetType` / `targetId` are exact-match string filters; `limit` / `offset` are
 * server-clamped (`[1, 200]`, `≥ 0`). All absent → the server default (50, offset 0, all actors). */
export interface AuditFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  offset?: number;
}

/**
 * The `/admin/audit` read endpoint. `getAudit` unwraps the `{ entries }` envelope so consumers get the
 * (newest-first) array directly, and takes an optional filter that builds only the params that are
 * present (like `accountsApi.getAccounts` / `transactionsApi.getTransactions`). The audit log is
 * strictly READ-ONLY — there are no mutations here, so `providesTags` is a single static LIST tag and
 * nothing ever invalidates it. Reuses `baseApi`'s bearer wiring.
 */
export const auditApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getAudit: build.query<AuditLogDto[], AuditFilter | void>({
      query: (arg) => {
        const params: Record<string, string> = {};
        if (arg) {
          if (arg.actorId) {
            params.actorId = arg.actorId;
          }
          if (arg.action) {
            params.action = arg.action;
          }
          if (arg.targetType) {
            params.targetType = arg.targetType;
          }
          if (arg.targetId) {
            params.targetId = arg.targetId;
          }
          if (arg.limit !== undefined) {
            params.limit = String(arg.limit);
          }
          if (arg.offset !== undefined) {
            params.offset = String(arg.offset);
          }
        }
        return { url: 'audit', params };
      },
      transformResponse: (response: AuditLogResponse) => response.entries,
      providesTags: [{ type: 'Audit', id: 'LIST' }],
    }),
  }),
});

export const { useGetAuditQuery } = auditApi;
