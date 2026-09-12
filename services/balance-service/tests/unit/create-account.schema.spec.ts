/**
 * Spec 04 — Balance Service, customer self-service account creation: the `POST /api/accounts`
 * body validation schema (`createAccountSchema`), driven as a PURE unit (no DB, no Nest) so it
 * runs in the DEFAULT `npm test`.
 *
 * Written FROM the developer-locked contract, NOT the implementation:
 *   - `{ label }` where `label` is a customer-chosen display name, 1–50 chars AFTER trim, free of
 *     control characters. Surrounding whitespace is TRIMMED (the PARSED value is the trimmed label,
 *     which is what the service stores/returns).
 *   - The object is `.strict()`: any UNKNOWN key is rejected — notably a smuggled `ownerId` (the
 *     owner is taken ONLY from the trusted gateway identity, never the body). A caller must not be
 *     able to inject fields.
 *   - A non-string `label`, an empty/whitespace-only `label`, and a `label` longer than 50 chars
 *     after trim are all rejected.
 *
 * The schema is the first-line security control on untrusted input; each case here can FAIL on a
 * real defect (a dropped `.strict()`, a missing trim, an off-by-one length bound, a control-char
 * hole). The zod-to-HTTP-400 mapping is proven separately (zod-validation.pipe.spec + the e2e), so
 * this suite asserts the PARSE outcome directly (`safeParse().success` + the parsed value).
 */
import { getCreateAccountSchema } from '../support/harness';

const schema = getCreateAccountSchema();

/** Parse `{ label }` and report success + the parsed value (or the issues). */
function parse(body: unknown): { ok: boolean; value?: any } {
  const res = schema.safeParse(body);
  return res.success ? { ok: true, value: res.data } : { ok: false };
}

describe('createAccountSchema — POST /api/accounts { label } validation (pure, no DB)', () => {
  it('accepts a well-formed label and returns it verbatim', () => {
    const res = parse({ label: 'Savings' });
    expect(res.ok).toBe(true);
    expect(res.value.label).toBe('Savings');
  });

  it('TRIMS surrounding whitespace — the parsed label is the trimmed value the service stores', () => {
    const res = parse({ label: '   Rent Money   ' });
    expect(res.ok).toBe(true);
    // The whole point: what reaches the service (and is stored/returned) is trimmed.
    expect(res.value.label).toBe('Rent Money');
  });

  it('accepts the boundary lengths: 1 char and exactly 50 chars (after trim)', () => {
    expect(parse({ label: 'x' }).ok).toBe(true);
    const fifty = 'a'.repeat(50);
    const at50 = parse({ label: fifty });
    expect(at50.ok).toBe(true);
    expect(at50.value.label).toBe(fifty);
    // 50 chars surrounded by whitespace still passes — length is measured AFTER trim.
    const padded = parse({ label: `   ${fifty}   ` });
    expect(padded.ok).toBe(true);
    expect(padded.value.label).toBe(fifty);
  });

  it('rejects a missing label', () => {
    expect(parse({}).ok).toBe(false);
  });

  it('rejects an empty and a whitespace-only label (min 1 AFTER trim)', () => {
    expect(parse({ label: '' }).ok).toBe(false);
    expect(parse({ label: '   ' }).ok).toBe(false);
    expect(parse({ label: '\t\n ' }).ok).toBe(false);
  });

  it('rejects a label longer than 50 chars after trim (off-by-one guard at 51)', () => {
    expect(parse({ label: 'a'.repeat(51) }).ok).toBe(false);
    // Leading/trailing whitespace does not rescue an over-length core.
    expect(parse({ label: `  ${'a'.repeat(51)}  ` }).ok).toBe(false);
  });

  it('rejects a non-string label (number, boolean, null, object, array)', () => {
    for (const bad of [123, true, null, {}, ['x'], 12.5]) {
      expect(parse({ label: bad }).ok).toBe(false);
    }
  });

  it('rejects a label containing control characters (C0, DEL, and C1)', () => {
    // The control chars are built from CODE POINTS so the source file holds NO raw control bytes
    // (a raw NUL/BEL/DEL in a literal would make git treat this file as binary / unreviewable).
    const withControl = (code: number): string => `ab${String.fromCharCode(code)}cd`;
    // C0 (<= 0x1f): NUL, BEL, newline (0x0a), unit-separator (0x1f); DEL (0x7f); C1 (0x80–0x9f):
    // NEL (0x85). Every one must be rejected — a display label may never carry a control character.
    for (const code of [0x00, 0x07, 0x0a, 0x1f, 0x7f, 0x85]) {
      expect(parse({ label: withControl(code) }).ok).toBe(false);
    }
    // A tab embedded MID-string (not just trimmed off the ends) is also a control char → rejected.
    expect(parse({ label: withControl(0x09) }).ok).toBe(false);
  });

  it('is .strict(): an unknown extra key is rejected — a smuggled ownerId can never ride along', () => {
    // The owner is taken from the trusted gateway identity, NEVER the body: a body that also carries
    // ownerId must be rejected wholesale, not silently stripped-and-accepted.
    expect(parse({ label: 'ok', ownerId: 'sub-attacker' }).ok).toBe(false);
    expect(parse({ label: 'ok', balance: '999999' }).ok).toBe(false);
    expect(parse({ label: 'ok', kind: 'system' }).ok).toBe(false);
    expect(parse({ label: 'ok', accountNumber: '0000000000' }).ok).toBe(false);
    expect(parse({ label: 'ok', extra: 1 }).ok).toBe(false);
  });
});
