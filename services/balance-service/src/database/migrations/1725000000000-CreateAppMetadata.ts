import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sample foundation migration. Creates `app_metadata` and seeds a schema-version
 * row — just enough to prove migrations run on boot (via `migrationsRun`) against
 * the `balance` database. No domain tables (those arrive in spec 04).
 */
export class CreateAppMetadata1725000000000 implements MigrationInterface {
  name = 'CreateAppMetadata1725000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "app_metadata" (
        "key" varchar PRIMARY KEY,
        "value" varchar NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      INSERT INTO "app_metadata" ("key", "value") VALUES ('schema_version', '1')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "app_metadata"`);
  }
}
