import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Confirmation-of-payee support (spec 04): the balance-service's own customer representation
 * plus the human account number a transfer is addressed to.
 *
 * - `customer`: the money-domain profile Keycloak does not hold. PK `id` is the Keycloak `sub`
 *   — the SAME value stored in `account.owner_id`, so it stays `varchar` and `owner_id` gains
 *   an FK to it with NO type change and NO risky column ALTER.
 * - `account.account_number`: the human destination identifier (a unique 10-digit numeric
 *   string), NULLable and on customer accounts only. A PLAIN unique index enforces uniqueness —
 *   Postgres allows multiple NULLs, so the system/clearing accounts (NULL number) never collide.
 * - `fk_account_owner`: `account.owner_id → customer.id`. It is nullable, so it is not checked
 *   for system accounts (NULL owner). No customer accounts exist in the migration chain (only
 *   the system accounts are seeded here), so adding the constraint cannot fail on existing data.
 */
export class CreateCustomerAndAccountNumber1789084800000 implements MigrationInterface {
  name = 'CreateCustomerAndAccountNumber1789084800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "customer" (
        "id" varchar PRIMARY KEY,
        "name" varchar NOT NULL,
        "phone" varchar NOT NULL,
        "email" varchar NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`ALTER TABLE "account" ADD COLUMN "account_number" varchar`);
    // Unique across customer account numbers; multiple NULLs (system accounts) coexist.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_account_account_number" ON "account" ("account_number")`,
    );
    // owner_id → customer.id; nullable, so system accounts (NULL owner) are not checked.
    await queryRunner.query(
      `ALTER TABLE "account" ADD CONSTRAINT "fk_account_owner" FOREIGN KEY ("owner_id") REFERENCES "customer" ("id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "account" DROP CONSTRAINT "fk_account_owner"`);
    await queryRunner.query(`DROP INDEX "uq_account_account_number"`);
    await queryRunner.query(`ALTER TABLE "account" DROP COLUMN "account_number"`);
    await queryRunner.query(`DROP TABLE "customer"`);
  }
}
