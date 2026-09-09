import { DeepPartial } from 'typeorm';
import { LedgerEntry } from '../entities/ledger-entry.entity';

/** DI token for {@link ILedgerEntryRepository}. */
export const LEDGER_ENTRY_REPOSITORY = Symbol('LEDGER_ENTRY_REPOSITORY');

/** Persistence port for {@link LedgerEntry} (append-only). Reconstruction/sum queries are
 * deferred to the domain step, where the posting reducer drives them. */
export interface ILedgerEntryRepository {
  findById(id: string): Promise<LedgerEntry | null>;
  create(data: DeepPartial<LedgerEntry>): Promise<LedgerEntry>;
  /** One account's ledger legs (its per-account statement), newest-first
   * (`created_at DESC, id DESC` — the `id` tiebreak makes ties deterministic).
   * Backed by `idx_ledger_account_created`. MUST be bounded — `limit` caps the row
   * count; there is deliberately no unbounded variant. */
  findByAccount(accountId: string, limit: number): Promise<LedgerEntry[]>;
}
