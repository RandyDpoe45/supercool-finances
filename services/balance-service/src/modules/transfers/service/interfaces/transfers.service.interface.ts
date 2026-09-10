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

/**
 * A transfer enriched with the HUMAN account numbers the wire shows in place of the raw
 * account UUIDs (the entity stores debit/credit UUIDs; the service resolves them). Mirrors how
 * {@link IAccountsService.getAccountStatement} returns `{ account, entries }`: the raw entity
 * never reaches the wire — the controller whitelists this view.
 */
export interface TransferView {
  transaction: Transaction;
  sourceAccountNumber: string | null;
  destinationAccountNumber: string | null;
}

/**
 * A pending transfer enriched for the OTP app's feed: the human account numbers PLUS the
 * destination holder's MASKED name (so the app shows who the payment is to). The masking is
 * applied by the service — the raw name (PII) never reaches the controller.
 */
export interface PendingAuthorizationView {
  transaction: Transaction;
  sourceAccountNumber: string | null;
  destinationAccountNumber: string | null;
  destinationMaskedName: string;
}

/**
 * The internal-transfer lifecycle service (spec 04 Transfers). Two-phase and OTP-gated, and
 * fronted by a confirmation-of-payee step: resolve a destination (query only) → a masked name +
 * a confirmation token → the token is REQUIRED by initiate. A transfer is created PENDING at
 * initiate (no money moves) and posts on OTP-confirm, with the funds check performed at
 * confirm-time under the account lock. Returns enriched VIEW MODELS (human account numbers,
 * masked names) — DTO serialization is a transport concern applied at the controller boundary.
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
   * destination, then create a PENDING transaction under the `Idempotency-Key` (a replay
   * returns the original). No money moves. Returns the PENDING transfer view.
   */
  initiateTransfer(params: InitiateTransferParams): Promise<TransferView>;

  /**
   * Confirm a PENDING transfer: verify+consume the caller's one-time code, then post the
   * transfer (money moves) via a guarded transition. An already-POSTED transfer is returned
   * as an idempotent replay. Returns the POSTED transfer view.
   */
  confirmTransfer(params: ConfirmTransferParams): Promise<TransferView>;

  /** The caller's PENDING transfers, newest-first (the OTP app's pending-authorizations feed),
   * each enriched with the destination holder's masked name. */
  listPendingAuthorizations(ownerId: string): Promise<PendingAuthorizationView[]>;
}
