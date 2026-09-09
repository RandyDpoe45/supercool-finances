/**
 * Base class for framework-agnostic domain errors — thrown by services when a business
 * invariant is violated (insufficient funds, frozen account, currency mismatch, …). It
 * deliberately carries NO `@nestjs/common` HttpException coupling: the service layer owns
 * business rules, not transport. The mapping from a `DomainError` to an HTTP status +
 * {@link ErrorResponse} is a controller/edge concern added when the write endpoints land
 * (see docs/domain.md — deferred HTTP mapping).
 *
 * Every domain error carries a stable, machine-readable `code` (e.g. `INSUFFICIENT_FUNDS`)
 * for that future edge mapping and for logs — decoupled from the HTTP status so a caller
 * can branch on the domain reason, not the transport code.
 */
export abstract class DomainError extends Error {
  /** Stable domain reason code, distinct from any HTTP status. */
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    // Preserve the concrete subclass name and a correct prototype chain so `instanceof`
    // works regardless of transpilation target.
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
