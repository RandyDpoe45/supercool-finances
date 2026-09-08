import { NotFoundException } from '@nestjs/common';
import { FindOptionsWhere, ObjectLiteral, Repository } from 'typeorm';

/**
 * Owner-scoped lookup — the anti-IDOR (BOLA) pattern for the customer plane
 * (ADR-3). Ownership is enforced *inside* the query (`... AND owner_id = :sub`),
 * not as a separate pre-check, and a non-owned or missing row yields **404** (not
 * 403) to avoid leaking existence via enumeration.
 *
 * This establishes the pattern for spec 04; it is intentionally not yet wired to a
 * domain endpoint (no domain entities exist at the foundation).
 *
 * @param ownerColumn the entity property that holds the owner id (default `ownerId`).
 */
export async function findOwnedOrFail<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  criteria: FindOptionsWhere<Entity>,
  ownerId: string,
  ownerColumn: keyof Entity & string = 'ownerId',
): Promise<Entity> {
  const where = { ...criteria, [ownerColumn]: ownerId } as FindOptionsWhere<Entity>;
  const found = await repository.findOne({ where });
  if (!found) {
    throw new NotFoundException('Resource not found');
  }
  return found;
}
