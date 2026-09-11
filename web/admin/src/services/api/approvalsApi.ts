import { baseApi } from './baseApi';
import type { ApprovalRequestDto, ApprovalsResponse } from './contracts/approval';

/**
 * The maker-checker reversal endpoints on the balance-service admin surface.
 *
 * - `getApprovals` unwraps the `{ approvals }` envelope; an omitted `status` lets the SERVER default
 *   to the PENDING queue (the checker's work list). `providesTags` per-id + a `'Approval'` LIST tag.
 * - `proposeReversal` (the MAKER action) POSTs `transfers/:id/reverse` with the target TRANSACTION id
 *   in the path; the `reason` is sent as a body ONLY when it is a non-empty string (an empty/absent
 *   reason sends no body, matching the server's optional `.strict()` schema). It invalidates the
 *   `'Approval'` LIST — the pending queue gains the new proposal.
 * - `approveReversal` / `rejectReversal` (the CHECKER actions) POST `approvals/:id/approve|reject`
 *   with the APPROVAL id in the path. Approve executes the reversal atomically server-side, so it
 *   invalidates both the `'Approval'` LIST + that approval's id AND the `'Transaction'` LIST (the
 *   original flips to REVERSED and a compensating tx appears). Reject only touches the approval.
 *
 * All path ids are `encodeURIComponent`-escaped (mirroring `accountsApi`); all reuse `baseApi`'s
 * bearer wiring.
 */
export const approvalsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getApprovals: build.query<ApprovalRequestDto[], { status?: string } | void>({
      query: (arg) => {
        const params: Record<string, string> = {};
        if (arg && arg.status) {
          params.status = arg.status;
        }
        return { url: 'approvals', params };
      },
      transformResponse: (response: ApprovalsResponse) => response.approvals,
      providesTags: (approvals) =>
        approvals
          ? [
              ...approvals.map((approval) => ({ type: 'Approval' as const, id: approval.id })),
              { type: 'Approval' as const, id: 'LIST' },
            ]
          : [{ type: 'Approval' as const, id: 'LIST' }],
    }),
    proposeReversal: build.mutation<ApprovalRequestDto, { transactionId: string; reason?: string }>(
      {
        query: ({ transactionId, reason }) => {
          const trimmed = typeof reason === 'string' ? reason.trim() : '';
          return {
            url: `transfers/${encodeURIComponent(transactionId)}/reverse`,
            method: 'POST',
            // The body is optional: send `{ reason }` only when a non-empty reason was entered, else no
            // body at all (the server normalizes an absent body to `{}`).
            ...(trimmed !== '' ? { body: { reason: trimmed } } : {}),
          };
        },
        invalidatesTags: [{ type: 'Approval', id: 'LIST' }],
      },
    ),
    approveReversal: build.mutation<ApprovalRequestDto, string>({
      query: (id) => ({ url: `approvals/${encodeURIComponent(id)}/approve`, method: 'POST' }),
      invalidatesTags: (_result, _error, id) => [
        { type: 'Approval', id: 'LIST' },
        { type: 'Approval', id },
        { type: 'Transaction', id: 'LIST' },
      ],
    }),
    rejectReversal: build.mutation<ApprovalRequestDto, string>({
      query: (id) => ({ url: `approvals/${encodeURIComponent(id)}/reject`, method: 'POST' }),
      invalidatesTags: (_result, _error, id) => [
        { type: 'Approval', id: 'LIST' },
        { type: 'Approval', id },
      ],
    }),
  }),
});

export const {
  useGetApprovalsQuery,
  useProposeReversalMutation,
  useApproveReversalMutation,
  useRejectReversalMutation,
} = approvalsApi;
