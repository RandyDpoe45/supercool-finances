/**
 * Spec 04 — Balance Service, Transfers: the controller-boundary transfer serializers, after the
 * PR #19 review-fix layering change. Written FROM the developer-locked contract, NOT the impl:
 *
 *   - services now return DOMAIN objects; the controller serializes to DTOs via EXPLICIT whitelist
 *     functions. `serializeTransfer(transaction)` takes the Transaction ENTITY and emits a DTO that
 *     - INCLUDES `expiresAt` (ISO string, or null when the transfer has no expiry),
 *     - does NOT include `destinationAccountNumber` (the entity only carries the raw credit UUID,
 *       which must never cross the wire — the human destination number is a read-model concern),
 *     - leaks NO internal / PII field (initiatedBy, failureReason, failedAt, payeeId,
 *       reversesTransactionId, or the raw creditAccountId UUID).
 *   - `serializePendingAuthorization({ transaction, destinationAccountNumber, destinationMaskedName })`
 *     emits the pending DTO carrying the destination's MASKED name + `destinationAccountNumber`
 *     (masking done in the service) and ADDS `expiresAt`.
 *
 * The point of this suite is anti-leak: feeding a FULL entity-shaped object with SENTINEL secrets
 * and asserting the DTO neither carries the forbidden keys nor stringifies the sentinel values
 * fails on exactly that defect (a spread/auto-serialize would expose them). Pure — NO DB, NO Nest
 * — so it runs in the DEFAULT `npm test`. The serializers are imported through the single seam
 * (tests/support/harness.ts:getTransferSerializers); if they are not resolvable there the suite
 * honest-SKIPs (the e2e still proves the wire shape over HTTP), consistent with the repo's
 * best-effort resolver discipline.
 */
import { getTransferSerializers } from '../support/harness';

const { serializeTransfer, serializePendingAuthorization } = getTransferSerializers();

const suite = serializeTransfer && serializePendingAuthorization ? describe : describe.skip;
if (!serializeTransfer || !serializePendingAuthorization) {
  console.info(
    '[unit] SKIPPED transfers-serializer suite: serializeTransfer / serializePendingAuthorization ' +
      'are not resolvable via tests/support/harness.ts:getTransferSerializers. Add their ' +
      'path/export there to activate this suite (the e2e still proves the wire shape).',
  );
}

/** Internal / PII fields that live on the Transaction entity but MUST NOT reach a customer DTO. */
const FORBIDDEN_KEYS = [
  'initiatedBy',
  'failureReason',
  'failedAt',
  'payeeId',
  'reversesTransactionId',
  'creditAccountId', // the raw destination UUID
];

/** A full Transaction-entity fixture with SENTINEL secrets on every field that must be withheld. */
function fullTransaction(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'tx-11111111-1111-1111-1111-111111111111',
    type: 'internal',
    status: 'PENDING',
    amount: '2000',
    currency: 'MXN',
    debitAccountId: 'src-ACCOUNT-owned-by-caller', // → sourceAccountId (the caller's own, allowed)
    creditAccountId: 'credit-UUID-SECRET-do-not-leak', // raw destination UUID — must be withheld
    initiatedBy: 'sub-SECRET-owner-do-not-leak',
    failureReason: 'SECRET-failure-reason',
    failedAt: new Date('2026-04-04T04:04:04.000Z'),
    payeeId: 'payee-SECRET',
    reversesTransactionId: 'tx-SECRET-reversed',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    postedAt: null,
    expiresAt: new Date('2026-01-01T00:02:00.000Z'),
    ...overrides,
  };
}

suite('serializeTransfer — entity -> TransferDto whitelist (pure, no DB)', () => {
  const toDto = serializeTransfer as (t: any) => any;

  it('INCLUDES expiresAt and does NOT include destinationAccountNumber', () => {
    const dto = toDto(fullTransaction());
    expect('expiresAt' in dto).toBe(true);
    expect('destinationAccountNumber' in dto).toBe(false);
  });

  it('leaks NO internal/PII field (initiatedBy, failureReason, failedAt, payeeId, reversesTransactionId, raw credit UUID)', () => {
    const dto = toDto(fullTransaction());
    const leakedKeys = FORBIDDEN_KEYS.filter((k) => k in dto);
    expect(leakedKeys).toEqual([]);
    // Value-level anti-leak: none of the sentinel secrets appear anywhere in the serialized DTO,
    // even under a differently-named key (a spread of the entity would surface them).
    const serialized = JSON.stringify(dto);
    for (const secret of [
      'credit-UUID-SECRET-do-not-leak',
      'sub-SECRET-owner-do-not-leak',
      'SECRET-failure-reason',
      'payee-SECRET',
      'tx-SECRET-reversed',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("exposes the caller's OWN source account id (from debitAccountId) — that is not a leak", () => {
    const dto = toDto(fullTransaction({ debitAccountId: 'src-abc' }));
    expect(dto.sourceAccountId).toBe('src-abc');
  });

  it('renders postedAt and expiresAt as ISO-8601 strings when set', () => {
    const dto = toDto(
      fullTransaction({
        status: 'POSTED',
        postedAt: new Date('2026-03-03T12:34:56.000Z'),
        expiresAt: new Date('2026-03-03T12:32:56.000Z'),
      }),
    );
    expect(dto.postedAt).toBe('2026-03-03T12:34:56.000Z');
    expect(dto.expiresAt).toBe('2026-03-03T12:32:56.000Z');
  });

  it('renders a null postedAt / null expiresAt as null (not undefined, not dropped)', () => {
    const dto = toDto(fullTransaction({ postedAt: null, expiresAt: null }));
    expect(dto.postedAt).toBeNull();
    expect(dto.expiresAt).toBeNull();
  });

  // P2b (spec 05 producer side): a business-failed external initiate returns a TERMINAL FAILED
  // transaction; the controller answers 201 with a body whose `status` is "FAILED". The wire body
  // renders `status` and null `postedAt`/`expiresAt`, and — as with any transfer — MUST NOT carry
  // `failureReason` (an internal column): the client sees only that it FAILED, never the domain code.
  it('renders a FAILED transaction as status "FAILED" with null postedAt/expiresAt and does NOT leak failureReason', () => {
    const dto = toDto(
      fullTransaction({
        type: 'external_outbound',
        status: 'FAILED',
        failureReason: 'INSUFFICIENT_FUNDS',
        failedAt: new Date('2026-04-04T04:04:04.000Z'),
        postedAt: null,
        expiresAt: null,
      }),
    );
    expect(dto.status).toBe('FAILED');
    expect(dto.postedAt).toBeNull();
    expect(dto.expiresAt).toBeNull();
    // failureReason is an internal column — never on the wire (neither as a key nor as a value).
    expect('failureReason' in dto).toBe(false);
    expect('failedAt' in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain('INSUFFICIENT_FUNDS');
  });
});

suite('serializePendingAuthorization — read model -> PendingAuthorizationDto (pure, no DB)', () => {
  const toDto = serializePendingAuthorization as (p: any) => any;

  /**
   * The domain read model the service returns: entity + resolved destination number + masked name.
   * `txOverrides` MERGE into the full transaction fixture (so `createdAt`/`expiresAt`, which the
   * serializer reads via `.toISOString()`, are always present); `rest` overrides the top-level
   * read-model fields.
   */
  function readModel(
    txOverrides: Record<string, unknown> = {},
    rest: Record<string, unknown> = {},
  ): any {
    return {
      transaction: fullTransaction({
        expiresAt: new Date('2026-05-05T00:02:00.000Z'),
        ...txOverrides,
      }),
      destinationAccountNumber: '2222222222',
      destinationMaskedName: 'Jua** Per**',
      ...rest,
    };
  }

  it('carries the destination MASKED name + destinationAccountNumber and ADDS expiresAt', () => {
    const dto = toDto(readModel());
    expect(dto.destinationMaskedName).toBe('Jua** Per**');
    expect(dto.destinationAccountNumber).toBe('2222222222');
    expect('expiresAt' in dto).toBe(true);
    expect(dto.expiresAt).toBe('2026-05-05T00:02:00.000Z'); // ISO from transaction.expiresAt
  });

  it("exposes the caller's own sourceAccountId and leaks no internal/PII field or raw destination UUID", () => {
    const dto = toDto(readModel({ debitAccountId: 'src-xyz' }));
    expect(dto.sourceAccountId).toBe('src-xyz');
    const leakedKeys = FORBIDDEN_KEYS.filter((k) => k in dto);
    expect(leakedKeys).toEqual([]);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('credit-UUID-SECRET-do-not-leak');
    expect(serialized).not.toContain('sub-SECRET-owner-do-not-leak');
  });
});
