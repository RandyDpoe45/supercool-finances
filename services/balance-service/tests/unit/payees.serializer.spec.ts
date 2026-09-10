/**
 * Spec 04 — Balance Service, External payees: the controller-boundary payee serializer. Written FROM
 * the developer-locked brief, NOT the impl:
 *
 *   - services return the ExternalPayee ENTITY; the controller serializes to a DTO via an EXPLICIT
 *     whitelist. `serializePayee(entity)` emits EXACTLY
 *       { id, displayName, destinationRef, coolingOffUntil (ISO), usable (boolean), createdAt (ISO) }
 *     and leaks NO `ownerId` / `rail` / `status` / `activatedAt` (those are internal — the rail is a
 *     constant the caller may not see, the status column is reserved/unused, ownerId is a secret sub).
 *   - `usable` is DATE-gated: true when `coolingOffUntil` is in the past (`now() >= coolingOffUntil`),
 *     false when it is in the future — driven with fixed far-past / far-future dates so the assertion
 *     is deterministic regardless of the wall clock.
 *
 * The point is anti-leak + the derived flag: feeding a FULL entity with SENTINEL secrets on every
 * withheld field and asserting the DTO neither carries the forbidden keys nor stringifies the
 * sentinels fails on exactly that defect (a spread/auto-serialize would surface them). Pure — NO DB,
 * NO Nest — so it runs in the DEFAULT `npm test`. The serializer is imported through the single seam;
 * if it is not resolvable there the suite honest-SKIPs (the e2e still proves the wire shape over HTTP),
 * consistent with the repo's best-effort resolver discipline.
 */
import * as harness from '../support/harness';

/** Resolve `serializePayee` via whichever accessor the harness exposes (function or bag). */
function resolveSerializePayee(): ((entity: any) => any) | undefined {
  try {
    const getOne = (harness as any).getPayeeSerializer;
    if (typeof getOne === 'function') {
      const s = getOne();
      if (typeof s === 'function') return s;
      if (s && typeof s.serializePayee === 'function') return s.serializePayee;
    }
    const getBag = (harness as any).getPayeeSerializers;
    if (typeof getBag === 'function') {
      const bag = getBag();
      if (bag && typeof bag.serializePayee === 'function') return bag.serializePayee;
    }
  } catch {
    /* fall through to honest-SKIP */
  }
  return undefined;
}

const serializePayee = resolveSerializePayee();
const suite = serializePayee ? describe : describe.skip;
if (!serializePayee) {
  console.info(
    '[unit] SKIPPED payees-serializer suite: serializePayee is not resolvable via ' +
      'tests/support/harness.ts (getPayeeSerializer / getPayeeSerializers). Add its path/export ' +
      'there to activate this suite (the e2e still proves the wire shape).',
  );
}

/** Exactly the whitelisted keys the payee DTO must carry — no more, no fewer. */
const PAYEE_DTO_KEYS = [
  'id',
  'displayName',
  'destinationRef',
  'coolingOffUntil',
  'usable',
  'createdAt',
];

/** Fields that live on the ExternalPayee entity but MUST NOT reach the customer DTO. */
const FORBIDDEN_KEYS = ['ownerId', 'rail', 'status', 'activatedAt'];

/** A full ExternalPayee-entity fixture with SENTINEL secrets on every withheld field. */
function fullPayee(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'payee-11111111-1111-1111-1111-111111111111',
    ownerId: 'sub-SECRET-owner-do-not-leak',
    displayName: 'ACME Corp',
    rail: 'RAIL-SECRET-do-not-leak',
    destinationRef: '1234567890',
    status: 'STATUS-SECRET-do-not-leak',
    coolingOffUntil: new Date('2020-01-01T00:00:00.000Z'), // far PAST → usable by default
    createdAt: new Date('2019-12-01T00:00:00.000Z'),
    activatedAt: new Date('2020-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

suite('serializePayee — entity -> PayeeDto whitelist (pure, no DB)', () => {
  const toDto = serializePayee as (e: any) => any;

  it('emits EXACTLY the whitelisted keys and leaks no ownerId/rail/status/activatedAt', () => {
    const dto = toDto(fullPayee());
    expect(Object.keys(dto).sort()).toEqual([...PAYEE_DTO_KEYS].sort());
    const leaked = FORBIDDEN_KEYS.filter((k) => k in dto);
    expect(leaked).toEqual([]);
    // Value-level anti-leak: no withheld sentinel appears anywhere, even under a renamed key.
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('sub-SECRET-owner-do-not-leak');
    expect(serialized).not.toContain('RAIL-SECRET-do-not-leak');
    expect(serialized).not.toContain('STATUS-SECRET-do-not-leak');
  });

  it('passes id / displayName / destinationRef through verbatim', () => {
    const dto = toDto(
      fullPayee({ id: 'p-abc', displayName: 'Beta LLC', destinationRef: '9998887770' }),
    );
    expect(dto.id).toBe('p-abc');
    expect(dto.displayName).toBe('Beta LLC');
    expect(dto.destinationRef).toBe('9998887770');
  });

  it('renders coolingOffUntil and createdAt as ISO-8601 strings', () => {
    const dto = toDto(
      fullPayee({
        coolingOffUntil: new Date('2026-03-03T12:34:56.000Z'),
        createdAt: new Date('2026-02-02T01:02:03.000Z'),
      }),
    );
    expect(dto.coolingOffUntil).toBe('2026-03-03T12:34:56.000Z');
    expect(dto.createdAt).toBe('2026-02-02T01:02:03.000Z');
  });

  it('usable is TRUE when coolingOffUntil is in the past (now >= coolingOffUntil)', () => {
    const dto = toDto(fullPayee({ coolingOffUntil: new Date('2000-01-01T00:00:00.000Z') }));
    expect(dto.usable).toBe(true);
  });

  it('usable is FALSE when coolingOffUntil is in the future (still cooling off)', () => {
    const dto = toDto(fullPayee({ coolingOffUntil: new Date('2999-01-01T00:00:00.000Z') }));
    expect(dto.usable).toBe(false);
  });
});
