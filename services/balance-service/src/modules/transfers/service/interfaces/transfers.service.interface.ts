import { Transaction } from '../../../../database/entities/transaction.entity';

/** DI token for {@link ITransfersService}. Consumers (the `/api` surface controller) depend on
 * the interface via this token, never the concrete class. */
export const TRANSFERS_SERVICE = Symbol('TRANSFERS_SERVICE');

/** Inputs to {@link ITransfersService.resolveDestination} — the confirmation-of-payee query. */
export interface ResolveDestinationParams {
  /** The caller (trusted gateway identity). The confirmation token is bound to this owner. */
  ownerId: string;
  /** The human destination identifier — a 10-digit numeric string. */
  accountNumber: string;
}

/**
 * The result of resolving a destination account number: the masked holder name (PII never
 * leaves the service raw), the destination currency, and a single-use confirmation token the
 * caller MUST present to `initiateTransfer`. NO transaction is created — this is a pure query.
 */
export interface DestinationResolution {
  maskedName: string;
  currency: string;
  confirmationToken: string;
}

/** Inputs to {@link ITransfersService.initiateTransfer}. All ids/currency come from the
 * validated request; `ownerId` is the trusted gateway identity, never the body. */
export interface InitiateTransferParams {
  ownerId: string;
  sourceAccountId: string;
  /** The human destination identifier (a 10-digit numeric string) — resolved to an account. */
  destinationAccountNumber: string;
  /** Positive magnitude in minor units (canonical `bigint` string — never float). */
  amount: string;
  currency: string;
  /** The client `Idempotency-Key`, claimed at INITIATE to dedup duplicate creation. */
  idempotencyKey: string;
  /** The token from a prior {@link ITransfersService.resolveDestination}; REQUIRED — a transfer
   * can only be initiated once the caller resolved+confirmed THIS destination. */
  confirmationToken: string;
  /** Override a suspected soft-duplicate (an identical payment within 60s) and proceed. */
  confirmDuplicate?: boolean;
}

/** Inputs to {@link ITransfersService.confirmTransfer}. */
export interface ConfirmTransferParams {
  ownerId: string;
  transferId: string;
  /** The out-of-band one-time code the caller received on `POST /api/otp`. */
  code: string;
}

/** Inputs to {@link ITransfersService.cancelTransfer} — the explicit cancel of the caller's own
 * pending transfer (guarded `PENDING → CANCELLED`, retained). */
export interface CancelTransferParams {
  ownerId: string;
  transferId: string;
}

/**
 * A pending transfer projected for the OTP app's feed. It is a DOMAIN read model, NOT raw
 * entities: the destination's HUMAN account number and the destination holder's MASKED name are
 * resolved HERE — masking is a PII/security rule that MUST stay in the service, so the raw name
 * never crosses the service boundary. The source account id is left on the `transaction`
 * (`debitAccountId`, the caller's own) for the controller to whitelist at serialize time.
 */
export interface PendingAuthorization {
  transaction: Transaction;
  destinationAccountNumber: string | null;
  destinationMaskedName: string;
}

/**
 * The internal-transfer lifecycle service (spec 04 Transfers). Two-phase and OTP-gated, and
 * fronted by a confirmation-of-payee step: resolve a destination (query only) → a masked name +
 * a confirmation token → the token is REQUIRED by initiate. A transfer is created PENDING at
 * initiate (no money moves), is single + time-boxed (at most one live pending per user; a
 * 2-minute `expires_at` from the DB clock; lazily EXPIRED on the next access; a new initiate
 * auto-supersedes the prior pending → CANCELLED; the caller may also cancel explicitly), and
 * posts on OTP-confirm with the funds check at confirm-time under the account lock.
 *
 * The write methods return the plain {@link Transaction} entity — DTO serialization is a
 * transport concern applied at the controller boundary. Only the pending READ returns a domain
 * PROJECTION ({@link PendingAuthorization}), because resolving + masking the destination is a
 * service-owned PII rule the raw entity cannot carry.
 */
export interface ITransfersService {
  /**
   * Confirmation of payee: resolve a destination by its account number to the masked holder
   * name + a single-use confirmation token bound to the caller. QUERY ONLY — no transaction is
   * created. The token must then be presented to {@link initiateTransfer}.
   */
  resolveDestination(params: ResolveDestinationParams): Promise<DestinationResolution>;

  /**
   * Initiate an internal (customer↔customer) transfer: validate + owner-scope the source,
   * resolve the destination by account number, verify the confirmation token binds to THIS
   * destination, then — inside the idempotency-wrapped transaction — expire any overdue pending,
   * auto-supersede any active pending (→ CANCELLED), and create the new PENDING transaction with
   * a DB-clock `expires_at` (a replay returns the original). No money moves. A truly-concurrent
   * same-initiator initiate collides on the single-pending index → conflict. Returns the PENDING
   * transfer entity.
   */
  initiateTransfer(params: InitiateTransferParams): Promise<Transaction>;

  /**
   * Confirm a PENDING transfer: CHECK EXPIRY FIRST (an expired/overdue transfer transitions to
   * EXPIRED and is rejected WITHOUT consuming the OTP), then verify+consume the caller's one-time
   * code and post the transfer (money moves) via a guarded transition. An already-POSTED transfer
   * is returned as an idempotent replay. Returns the POSTED transfer entity.
   */
  confirmTransfer(params: ConfirmTransferParams): Promise<Transaction>;

  /**
   * Explicitly cancel the caller's own PENDING transfer (guarded `PENDING → CANCELLED`, retained).
   * A POSTED transfer cannot be cancelled; an already CANCELLED / EXPIRED transfer is returned
   * as-is (idempotent). Owner-scoped on the debit account exactly like confirm. Returns the
   * (now CANCELLED, or concurrently-terminal) transfer entity.
   */
  cancelTransfer(params: CancelTransferParams): Promise<Transaction>;

  /** The caller's SINGLE active pending transfer (or `null`) for the OTP app's feed, projected
   * with the destination holder's masked name. Lazily expires an overdue pending (→ EXPIRED) and
   * returns `null` in that case — reading is one of the lazy-expiry access points. */
  getPendingAuthorization(ownerId: string): Promise<PendingAuthorization | null>;
}
