/**
 * Spec 04 — Balance Service, Step-4b: the DomainError → HTTP mapping of the (extended)
 * AllExceptionsFilter. Written FROM the developer-locked mapping contract, NOT from the
 * implementor's code:
 *
 *   INVALID_TRANSFER / INVALID_POSTING_COMMAND ............... 400
 *   ACCOUNT_NOT_FOUND / TRANSFER_NOT_FOUND .................. 404
 *   CURRENCY_MISMATCH / INSUFFICIENT_FUNDS ................. 422
 *   ACCOUNT_FROZEN / TRANSFER_NOT_PENDING /
 *     SUSPECTED_DUPLICATE / IDEMPOTENCY_KEY_REUSED /
 *     OTP_ALREADY_ACTIVE .................................. 409
 *   INVALID_OTP ........................................... 401
 *   OTP_LOCKED_OUT ........................................ 429
 *
 * The invariant this proves (a real defect surfaces here): a DomainError is rendered with the
 * mapped HTTP status AND the response `error.code` is the DOMAIN code (e.g. INSUFFICIENT_FUNDS),
 * NOT the status-derived vocabulary code (UNPROCESSABLE_ENTITY) — so a client branches on the
 * business reason, decoupled from transport. The domain message is PRESERVED for these 4xx
 * (the 5xx-only genericization must not swallow it) and the correlation `requestId` is threaded.
 *
 * The filter is exercised DIRECTLY (`filter.catch(exception, host)`) with a mock ArgumentsHost —
 * a pure unit test, no HTTP, no DB, runs in the DEFAULT `npm test`. For each domain code we feed
 * the REAL exported error class (resolved via the harness) where available; if a concrete class
 * is not yet resolvable we fall back to a SYNTHETIC subclass of the REAL DomainError base carrying
 * that code (the mapping is by `.code`, so this still exercises the contract). The two pre-existing
 * branches are re-proven so the extension does not regress them: an HttpException maps by its own
 * status + the status-derived code, and a generic Error becomes a leak-free 500.
 */
import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { resolveGuardsAndFilter, getDomainErrors, getDomainErrorBase } from '../support/harness';

const { AllExceptionsFilter } = resolveGuardsAndFilter();
const de = getDomainErrors();
const DomainErrorBase = getDomainErrorBase();

/** Drive the real filter with a mock ArgumentsHost and capture what it wrote to the response. */
function runFilter(
  exception: unknown,
  ctx: { requestId?: string; method?: string; url?: string } = {},
): { status: number | undefined; body: any } {
  const filter = new AllExceptionsFilter();
  const requestId = ctx.requestId ?? 'req-fixed-123';
  let status: number | undefined;
  let body: any;
  const response: any = {
    status(code: number) {
      status = code;
      return response;
    },
    json(payload: any) {
      body = payload;
      return response;
    },
  };
  const request: any = {
    requestId,
    method: ctx.method ?? 'POST',
    url: ctx.url ?? '/api/transfers',
  };
  const host: any = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  };
  filter.catch(exception, host);
  return { status, body };
}

/** The developer-locked DomainError code → HTTP status table, paired with the resolved concrete
 *  class (best-effort). This table is the spec-derived contract — the source of truth. */
const MAPPING: Array<{ code: string; status: number; cls: any }> = [
  { code: 'INVALID_POSTING_COMMAND', status: 400, cls: de.InvalidPostingCommandError },
  { code: 'INVALID_TRANSFER', status: 400, cls: de.InvalidTransferError },
  { code: 'ACCOUNT_NOT_FOUND', status: 404, cls: de.AccountNotFoundError },
  { code: 'TRANSFER_NOT_FOUND', status: 404, cls: de.TransferNotFoundError },
  { code: 'CURRENCY_MISMATCH', status: 422, cls: de.CurrencyMismatchError },
  { code: 'INSUFFICIENT_FUNDS', status: 422, cls: de.InsufficientFundsError },
  { code: 'ACCOUNT_FROZEN', status: 409, cls: de.AccountFrozenError },
  { code: 'TRANSFER_NOT_PENDING', status: 409, cls: de.TransferNotPendingError },
  { code: 'SUSPECTED_DUPLICATE', status: 409, cls: de.SuspectedDuplicateError },
  { code: 'IDEMPOTENCY_KEY_REUSED', status: 409, cls: de.IdempotencyKeyReuseError },
  { code: 'OTP_ALREADY_ACTIVE', status: 409, cls: de.OtpAlreadyActiveError },
  { code: 'INVALID_OTP', status: 401, cls: de.InvalidOtpError },
  { code: 'OTP_LOCKED_OUT', status: 429, cls: de.OtpLockedOutError },
];

/**
 * Build a DomainError instance carrying `code`. Prefer the REAL concrete class (so the proof holds
 * whether the filter dispatches on `.code` or on `instanceof <Specific>`); dummy positional args
 * are harmless (these constructors only interpolate them into a message). Fall back to a synthetic
 * subclass of the REAL DomainError base when the class is not yet exported.
 */
function makeDomainError(code: string, cls: any): { err: any; real: boolean } {
  if (cls) {
    try {
      const inst = new cls('acc-x', 'y', 'z');
      if (inst && typeof inst === 'object' && (inst as any).code === code) {
        return { err: inst, real: true };
      }
    } catch {
      /* fall through to synthetic */
    }
  }
  class SyntheticDomainError extends DomainErrorBase {
    readonly code = code;
    constructor() {
      super(`synthetic domain error for ${code}`);
    }
  }
  return { err: new SyntheticDomainError(), real: false };
}

describe('AllExceptionsFilter — DomainError → HTTP mapping (Step-4b)', () => {
  it.each(MAPPING)(
    'maps a $code DomainError to HTTP $status with error.code === the DOMAIN code, message preserved',
    ({ code, status, cls }) => {
      const { err, real } = makeDomainError(code, cls);
      if (!real) {
        // Honest signal (not a silent pass): the concrete class was not resolvable, so this row is
        // proven via a synthetic DomainError subclass. When the implementor exports the class the
        // real instance is used automatically.
        console.info(
          `[filter] ${code}: concrete class not resolved — using a synthetic DomainError.`,
        );
      }

      const { status: got, body } = runFilter(err, { requestId: 'req-abc' });

      expect(got).toBe(status); // the mapped transport status
      expect(body).toBeDefined();
      expect(body.error).toBeDefined();
      // The headline invariant: the machine-readable code is the DOMAIN reason, decoupled from the
      // status vocabulary. A filter that emitted codeForStatus(status) (e.g. 'UNPROCESSABLE_ENTITY'
      // for 422) instead of the domain code fails here.
      expect(body.error.code).toBe(code);
      // 4xx domain messages must NOT be genericized (only >=500 are) — the real message survives.
      expect(body.error.message).toBe(err.message);
      expect(typeof body.error.message).toBe('string');
      expect(body.error.message.length).toBeGreaterThan(0);
      // Correlation id threaded from the request.
      expect(body.error.requestId).toBe('req-abc');
    },
  );

  it('preserves the EXISTING HttpException branch: a NotFoundException → 404 with the status-derived code', () => {
    const { status, body } = runFilter(new NotFoundException('resource not found'));
    expect(status).toBe(404);
    // A framework HttpException still maps via codeForStatus (NOT a domain code) — the extension
    // must not hijack ordinary Nest exceptions.
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBe('resource not found');
    expect(body.error.requestId).toBe('req-fixed-123');
  });

  it('preserves the EXISTING generic-Error branch: an unknown Error → a leak-free 500', () => {
    const secret = 'sensitive: postgres://user:pass@host/db';
    const { status, body } = runFilter(new Error(secret));
    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Internal server error'); // genericized, cause not exposed
    // The sensitive cause must appear NOWHERE in the rendered response.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('sensitive:');
    expect(serialized).not.toContain('pass@host');
  });

  it('does NOT genericize a 4xx domain message even when its text is long/detailed (regression guard)', () => {
    // A CURRENCY_MISMATCH carries a descriptive message; mapped to 422 (a 4xx) it must be preserved
    // verbatim. Only >= 500 responses are genericized. This catches an over-broad genericization
    // that keys on "is this a domain error?" rather than "is the status >= 500?".
    const { err } = makeDomainError('CURRENCY_MISMATCH', de.CurrencyMismatchError);
    const { status, body } = runFilter(err);
    expect(status).toBe(422);
    expect(body.error.message).toBe(err.message);
    expect(body.error.message).not.toBe('Internal server error');
  });
});
