import { DeepPartial } from 'typeorm';
import { LedgerEntry } from '../entities/ledger-entry.entity';

/** DI token for {@link ILedgerEntryRepository}. */
export const LEDGER_ENTRY_REPOSITORY = Symbol('LEDGER_ENTRY_REPOSITORY');

/** Persistence port for {@link LedgerEntry} (append-only). Reconstruction/sum queries are
 * deferred to the domain step, where the posting reducer drives them. */
export interface ILedgerEntryRepository {
  findById(id: string): Promise<LedgerEntry | null>;
  create(data: DeepPartial<LedgerEntry>): Promise<LedgerEntry>;
}
