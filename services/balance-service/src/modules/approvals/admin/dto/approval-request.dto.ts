/**
 * Admin-plane view of an {@link ApprovalRequest} on the maker-checker reversal routes
 * (`POST /admin/transfers/:id/reverse`, `POST /admin/approvals/:id/approve|reject`). The admin is a
 * trusted, role-gated actor, so this exposes the maker/checker identities and the decision
 * timestamps. Every field is listed EXPLICITLY (the serializer never spreads the entity); the free-
 * form `payload` blob is NOT surfaced (it is an internal snapshot, not a wire contract).
 *
 * Timestamps are ISO-8601 UTC strings; `checkerId` / `decidedAt` / `executedAt` are null while the
 * request is still PENDING.
 */
export interface ApprovalRequestDto {
  id: string;
  actionType: string;
  status: string;
  makerId: string;
  checkerId: string | null;
  targetTransactionId: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
}
