import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, ZodSchema } from 'zod';

/**
 * A reusable pipe that validates a request value (body / header / query) against a zod
 * schema, returning the PARSED value on success so downstream code works on a typed,
 * shape-checked object rather than raw untrusted input. This is a security control: it
 * rejects malformed / unexpected input at the edge (param mishandling / injection defense)
 * before it can reach the domain services.
 *
 * On a validation failure it throws a {@link BadRequestException} (→ 400 `BAD_REQUEST` via
 * the global filter) with a SAFE, generic message: only the NAMES of the failing fields, never
 * the offending values or raw internals — so an attacker cannot probe the schema by reflecting
 * their payload back. Non-zod errors are rethrown untouched.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown): unknown {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const fields = [...new Set(error.issues.map((issue) => issue.path.join('.') || '(body)'))];
        throw new BadRequestException(`Invalid request: check field(s) ${fields.join(', ')}`);
      }
      throw error;
    }
  }
}
