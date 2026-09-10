import { describe, expect, it } from 'vitest';
import { describeTransferError, transferErrorCode } from '../src/lib/transferError';

/**
 * `transferError` turns the service's `{ error: { code, message, requestId } }` envelope into (a) a
 * stable domain CODE the page branches on and (b) a curated, PII-safe UI message. Defects these
 * catch: keying off the raw HTTP status instead of the domain code; SURFACING the server's raw
 * envelope message for a known code (which could leak internal detail); a mis-mapped/duplicated
 * message (a code showing another code's text); and a crash / wrong branch when the envelope is
 * malformed or the error is a transport failure.
 *
 * Content is asserted by DISTINCTIVE keywords per code (not full strings — that would only detect
 * wording churn), which is enough to catch a mapping swap while staying resilient to copy edits.
 */

/** Build an RTK Query `FetchBaseQueryError`-shaped error carrying the service envelope. */
function apiError(status: number, code: string, message = 'server envelope message') {
  return { status, data: { error: { code, message, requestId: 'req-1' } } };
}

const KNOWN_CODES = [
  'SUSPECTED_DUPLICATE',
  'IDEMPOTENCY_KEY_REUSED',
  'PENDING_TRANSFER_CONFLICT',
  'DESTINATION_NOT_CONFIRMED',
  'INVALID_TRANSFER',
  'CURRENCY_MISMATCH',
  'INSUFFICIENT_FUNDS',
  'LIMIT_EXCEEDED',
  'ACCOUNT_FROZEN',
  'TRANSFER_NOT_FOUND',
  'TRANSFER_NOT_PENDING',
  'TRANSFER_EXPIRED',
  'INVALID_OTP',
  'OTP_LOCKED_OUT',
] as const;

describe('describeTransferError — per-code curated messages', () => {
  it.each([
    ['SUSPECTED_DUPLICATE', [/duplicate/i, /anyway/i]],
    ['IDEMPOTENCY_KEY_REUSED', [/again/i]],
    ['PENDING_TRANSFER_CONFLICT', [/awaiting confirmation/i]],
    ['DESTINATION_NOT_CONFIRMED', [/confirm/i, /again/i]],
    ['INVALID_TRANSFER', [/not valid/i]],
    ['CURRENCY_MISMATCH', [/currenc/i]],
    ['INSUFFICIENT_FUNDS', [/insufficient/i]],
    ['LIMIT_EXCEEDED', [/limit/i]],
    ['ACCOUNT_FROZEN', [/frozen/i]],
    ['TRANSFER_NOT_FOUND', [/found/i]],
    ['TRANSFER_NOT_PENDING', [/no longer/i]],
    ['TRANSFER_EXPIRED', [/expired/i]],
    ['INVALID_OTP', [/code/i, /invalid/i]],
    ['OTP_LOCKED_OUT', [/too many/i]],
  ] as const)('maps %s to its distinctive message', (code, patterns) => {
    const message = describeTransferError(apiError(409, code));
    for (const pattern of patterns) {
      expect(message).toMatch(pattern);
    }
  });

  it('produces a DISTINCT message for every known code (no accidental collision)', () => {
    const messages = KNOWN_CODES.map((code) => describeTransferError(apiError(409, code)));
    expect(new Set(messages).size).toBe(KNOWN_CODES.length);
  });

  it('is keyed off the domain code, not the HTTP status (same status, different messages)', () => {
    // Both are 409 on the wire; the code decides the message.
    const dup = describeTransferError(apiError(409, 'SUSPECTED_DUPLICATE'));
    const notPending = describeTransferError(apiError(409, 'TRANSFER_NOT_PENDING'));
    expect(dup).not.toBe(notPending);
  });

  it('does NOT surface the raw envelope message for a known code (no leak)', () => {
    // A hypothetical over-detailed server message must never reach the UI verbatim for a code we
    // curate — the mapped message wins, so internal detail can't leak through.
    const leaky = apiError(401, 'INVALID_OTP', 'code 999999 wrong for user 42 (attempts=3)');
    const message = describeTransferError(leaky);
    expect(message).not.toContain('999999');
    expect(message).not.toContain('user 42');
    expect(message).not.toContain('attempts');
    expect(message).toMatch(/one-time code/i);
  });
});

describe('describeTransferError — safe degradation for unknown / malformed errors', () => {
  it('falls through to the (PII-light) envelope message for an unknown code', () => {
    const message = describeTransferError(
      apiError(400, 'A_BRAND_NEW_CODE', 'A safe fallback detail.'),
    );
    expect(message).toBe('A safe fallback detail.');
  });

  it('falls through to a generic phrase when an unknown code has no message', () => {
    const message = describeTransferError({ status: 500, data: { error: { code: 'MYSTERY' } } });
    expect(message).toMatch(/something went wrong/i);
  });

  it('gives a generic phrase for a transport failure with no envelope', () => {
    const message = describeTransferError({ status: 'FETCH_ERROR', error: 'network down' });
    expect(message).toMatch(/something went wrong/i);
  });
});

describe('transferErrorCode — robust extraction for flow branching', () => {
  it('extracts the domain code from a well-formed envelope', () => {
    expect(transferErrorCode(apiError(409, 'SUSPECTED_DUPLICATE'))).toBe('SUSPECTED_DUPLICATE');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a plain object', {}],
    ['a string', 'boom'],
    ['data null', { data: null }],
    ['data without error', { data: {} }],
    ['error null', { data: { error: null } }],
    ['error without code', { data: { error: {} } }],
    ['non-string code', { data: { error: { code: 42 } } }],
  ])('returns undefined for %s (never crashes / mis-branches)', (_label, error) => {
    expect(transferErrorCode(error)).toBeUndefined();
  });
});
