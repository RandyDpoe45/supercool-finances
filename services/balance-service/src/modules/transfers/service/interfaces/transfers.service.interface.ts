import { Transaction } from '../../../../database/entities/transaction.entity';

/** DI token for {@link ITransfersService}. Consumers (the `/api` surface controller) depend on
 * the interface via this token, never the concrete class. */
export const TRANSFERS_SERVICE = Symbol('TRANSFERS_SERVICE');

/** Inputs to {@link ITransfersService.initiateTransfer}. All ids/currency come from the
 * validated request; `ownerId` is the trusted gateway identity, never the body. */
export interface InitiateTransferParams {
  ownerId: string;
  sourceAccountId: string;
  destinationAccountId: string;
  /** Positive magnitude in minor units (canonical `bigint` string — never float). */
  amount: string;
  currency: string;
  /** The client `Idempotency-Key`, claimed at INITIATE to dedup duplicate creation. */
  idempotencyKey: string;
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
 * The internal-transfer lifecycle service (spec 04 Transfers). Two-phase and OTP-gated: a
 * transfer is created PENDING at initiate (no money moves) and posts on OTP-confirm, with the
 * funds check performed at confirm-time under the account lock. Returns ENTITIES — DTO
 * serialization is a transport concern applied at the controller boundary.
 */
export interface ITransfersService {
  /**
   * Initiate an internal (customer↔customer) transfer: validate + owner-scope the accounts,
   * then create a PENDING transaction under the `Idempotency-Key` (a replay returns the
   * original). No money moves. Returns the PENDING transfer entity.
   */
  initiateTransfer(params: InitiateTransferParams): Promise<Transaction>;

  /**
   * Confirm a PENDING transfer: verify+consume the caller's one-time code, then post the
   * transfer (money moves) via a guarded transition. An already-POSTED transfer is returned
   * as an idempotent replay. Returns the POSTED transfer entity.
   */
  confirmTransfer(params: ConfirmTransferParams): Promise<Transaction>;

  /** The caller's PENDING transfers, newest-first (the OTP app's pending-authorizations feed). */
  listPendingAuthorizations(ownerId: string): Promise<Transaction[]>;
}
