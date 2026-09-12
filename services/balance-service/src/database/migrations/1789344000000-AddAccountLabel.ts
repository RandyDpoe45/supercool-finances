import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer self-service account creation (spec 04): a nullable `label` on `account` — the
 * customer-chosen display name stamped on a self-created customer account. It is NULL on
 * seeded/system (clearing) accounts, which carry no customer-facing name.
 *
 * Deliberately NO index or constraint: a label is not unique per owner and is never a lookup
 * key — only a display field returned on the owner's own account reads. The column is added
 * NULL so the migration cannot fail on existing rows (they simply stay NULL).
 */
export class AddAccountLabel1789344000000 implements MigrationInterface {
  name = 'AddAccountLabel1789344000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "account" ADD COLUMN "label" varchar NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "account" DROP COLUMN "label"`);
  }
}
