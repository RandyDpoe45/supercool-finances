/**
 * App-local copy of the balance-service admin maker-checker reversal wire contract
 * (`GET /admin/approvals`, `POST /admin/transfers/:id/reverse`,
 * `POST /admin/approvals/:id/approve|reject`). Per ADR-16 the admin-app keeps its own copy, kept in
 * sync via specs/07-frontends.md — the contract of record. Mirrors balance-service's
 * `ApprovalRequestDto` serializer output.
 *
 * An `ApprovalRequest` is the four-eyes record of a proposed reversal: a MAKER proposes it (a PENDING
 * request) and a DIFFERENT CHECKER approves (executing the reversal atomically → EXECUTED) or rejects
 * it (→ REJECTED). `status` is one of `PENDING` / `APPROVED` / `REJECTED` / `EXECUTED` (open string;
 * the admin surface may see values beyond a bespoke set). `makerId` is the proposing admin;
 * `checkerId` / `decidedAt` / `executedAt` are `null` while the request is still PENDING.
 * `targetTransactionId` is the transaction the reversal targets. Timestamps are ISO-8601 UTC instants
 * (or `null`).
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

/** Envelope returned by `GET /admin/approvals`. */
export interface ApprovalsResponse {
  approvals: ApprovalRequestDto[];
}

/**
 * Body of `POST /admin/transfers/:id/reverse` (propose a reversal). The reversal TARGET is the path
 * `:id` (the target transaction uuid), NEVER the body; the maker id is resolved server-side from the
 * caller's identity. The body is entirely optional context — a free-form `reason` (1..500 chars)
 * recorded on the proposal. The server's `.strict()` schema rejects any other key (400 BAD_REQUEST).
 */
export interface ProposeReversalBody {
  reason?: string;
}
