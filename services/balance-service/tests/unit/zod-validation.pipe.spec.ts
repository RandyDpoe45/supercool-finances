/**
 * Spec 04 — Balance Service, Step-4b: the `ZodValidationPipe`. Written FROM the contract
 * (malformed request body/headers → 400, valid input passes through unchanged, and the rejection
 * message is safe / non-leaky), NOT from the implementor's code. The pipe is the mechanism behind
 * "bad uuid / non-integer / negative amount / missing required field → 400"; the actual transfer
 * schema's rejections are proven end-to-end over HTTP in the e2e suite. Here we prove the PIPE
 * itself against a representative schema (built from the `zod` dependency), so a defect in the
 * wrapping — swallowing an invalid value, throwing a 500 instead of a 400, or leaking internals —
 * is caught.
 *
 * Pure unit test: `new ZodValidationPipe(schema)` + `transform(value, metadata)`. No DB, no Nest
 * container — runs in the DEFAULT `npm test`, never skipped. The pipe class is resolved through
 * the single harness seam (`getZodValidationPipe`).
 */
import 'reflect-metadata';
import { BadRequestException, HttpException } from '@nestjs/common';
import { z } from 'zod';
import { getZodValidationPipe } from '../support/harness';

const ZodValidationPipe = getZodValidationPipe();

// A schema shaped like the transfer request body — the exact violation classes the contract names.
const bodySchema = z.object({
  sourceAccountId: z.string().uuid(),
  destinationAccountId: z.string().uuid(),
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  confirmDuplicate: z.boolean().optional(),
});

const VALID = {
  sourceAccountId: '11111111-1111-1111-1111-111111111111',
  destinationAccountId: '22222222-2222-2222-2222-222222222222',
  amount: 2000,
  currency: 'MXN',
};

const META = { type: 'body', metatype: Object, data: undefined } as any;

/** transform() may throw synchronously (Zod `.parse` throws) or return a rejected promise; capture
 *  both. Returns the thrown/rejected error, or a sentinel when it resolved. */
async function captureTransform(pipe: any, value: unknown): Promise<any> {
  try {
    const out = await pipe.transform(value, META);
    return { resolved: true, value: out };
  } catch (e) {
    return { resolved: false, error: e };
  }
}

describe('ZodValidationPipe — valid passthrough', () => {
  it('returns the parsed value unchanged for a well-formed body', async () => {
    const pipe = new ZodValidationPipe(bodySchema);
    const res = await captureTransform(pipe, VALID);
    expect(res.resolved).toBe(true);
    // The whitelisted, validated object comes back (not swallowed / not mutated away).
    expect(res.value).toMatchObject(VALID);
  });

  it('accepts the optional confirmDuplicate flag when present and boolean', async () => {
    const pipe = new ZodValidationPipe(bodySchema);
    const res = await captureTransform(pipe, { ...VALID, confirmDuplicate: true });
    expect(res.resolved).toBe(true);
    expect(res.value.confirmDuplicate).toBe(true);
  });
});

describe('ZodValidationPipe — schema violations reject with 400 (never a 500, never a silent pass)', () => {
  const cases: Array<[string, unknown]> = [
    ['a non-UUID account id', { ...VALID, sourceAccountId: 'not-a-uuid' }],
    ['a negative amount', { ...VALID, amount: -100 }],
    ['a non-integer (float) amount', { ...VALID, amount: 12.5 }],
    [
      'a missing required field (currency)',
      {
        sourceAccountId: VALID.sourceAccountId,
        destinationAccountId: VALID.destinationAccountId,
        amount: VALID.amount,
      },
    ],
    ['a wrong-typed field (amount as string)', { ...VALID, amount: '2000' }],
  ];

  it.each(cases)('rejects %s with BadRequestException (HTTP 400)', async (_label, value) => {
    const pipe = new ZodValidationPipe(bodySchema);
    const res = await captureTransform(pipe, value);

    expect(res.resolved).toBe(false); // MUST reject — never accept an invalid body
    expect(res.error).toBeInstanceOf(HttpException);
    expect(res.error).toBeInstanceOf(BadRequestException);
    expect((res.error as HttpException).getStatus()).toBe(400);
  });

  it('produces a SAFE (non-leaky) rejection: a bounded string message, no stack frames, no thrown-away raw dump', async () => {
    const pipe = new ZodValidationPipe(bodySchema);
    const res = await captureTransform(pipe, { ...VALID, sourceAccountId: 'not-a-uuid' });
    expect(res.resolved).toBe(false);

    const body = (res.error as HttpException).getResponse();
    const serialized = typeof body === 'string' ? body : JSON.stringify(body);
    expect(serialized.length).toBeGreaterThan(0);
    // No raw stack frames leaked into the client-facing payload.
    expect(serialized).not.toMatch(/\bat\s+.+:\d+:\d+/);
    // The message text is present and human-oriented (a 400 validation message), not empty.
    expect(serialized.toLowerCase()).toMatch(/valid|required|expected|uuid|invalid|string|number/);
  });
});
