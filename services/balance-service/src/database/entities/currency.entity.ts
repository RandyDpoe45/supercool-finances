import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * ISO 4217 currency reference/lookup table. Normalizes the currency of every
 * money-bearing row and carries `minor_unit_scale` so a `bigint` minor-units amount is
 * interpretable per currency. Prototype seeds MXN only (in the migration); adding a
 * currency is a data insert, not a migration.
 */
@Entity('currency')
export class Currency {
  @PrimaryColumn({ name: 'code', type: 'char', length: 3 })
  code!: string;

  @Column({ name: 'name', type: 'varchar' })
  name!: string;

  @Column({ name: 'minor_unit_scale', type: 'smallint' })
  minorUnitScale!: number;

  @Column({ name: 'symbol', type: 'varchar', nullable: true })
  symbol!: string | null;
}
