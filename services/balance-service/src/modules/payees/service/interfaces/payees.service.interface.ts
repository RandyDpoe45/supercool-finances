import { ExternalPayee } from '../../../../database/entities/external-payee.entity';

/** DI token for {@link IPayeesService}. Consumers (the `/api` surface controller) depend on the
 * interface via this token, never the concrete class. */
export const PAYEES_SERVICE = Symbol('PAYEES_SERVICE');

/** Inputs to {@link IPayeesService.registerPayee} — the minimal enrollment body. `ownerId` is the
 * trusted gateway identity, never the request body. The rail is NOT accepted from the caller: all
 * external outbound clears through one constant rail (set by the service). */
export interface RegisterPayeeParams {
  ownerId: string;
  /** Human-friendly label the customer supplies (there is no external name to look up). */
  displayName: string;
  /** The external bank account number (the human-identifier convention). */
  destinationRef: string;
}

/**
 * External-payee enrollment (spec 04 "External payees"). Enrollment is minimal — the caller
 * supplies only a display name and the external account number; the outbound rail is a constant.
 * Usability is **date-gated, not status-driven**: enrollment stamps `cooling_off_until = now() +
 * PAYEE_COOLING_OFF_SECONDS` (DB clock) and a payee is a valid destination from that instant on
 * (`now() >= cooling_off_until`). There is NO status lifecycle here — no PENDING→ACTIVE flip, no
 * `activated_at` stamping (both reserved for a future admin/self-disable flow, unused now).
 * Enrollment is NOT OTP-gated and has no resolve/confirm step; the cooling-off delay is the
 * anti-fraud control.
 *
 * The methods return the plain {@link ExternalPayee} entity — DTO serialization is a transport
 * concern applied at the controller boundary (layering rule).
 */
export interface IPayeesService {
  /**
   * Enroll an external beneficiary on the constant outbound rail, stamping the DB-clock
   * `cooling_off_until`. A duplicate `(owner_id, rail, destination_ref)` collides on `uq_payee`
   * and surfaces as `PayeeAlreadyEnrolledError` (409). Returns the new payee entity.
   */
  registerPayee(params: RegisterPayeeParams): Promise<ExternalPayee>;

  /** The caller's enrolled payees (`owner_id`). */
  listPayees(ownerId: string): Promise<ExternalPayee[]>;
}
