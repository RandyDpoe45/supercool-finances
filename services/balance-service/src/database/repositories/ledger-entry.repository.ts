import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { LedgerEntry } from '../entities/ledger-entry.entity';
import { ILedgerEntryRepository } from './ledger-entry.repository.interface';

/** TypeORM implementation of {@link ILedgerEntryRepository}, bound to
 * `LEDGER_ENTRY_REPOSITORY` in {@link PersistenceModule}. */
@Injectable()
export class LedgerEntryRepository implements ILedgerEntryRepository {
  constructor(@InjectRepository(LedgerEntry) private readonly repo: Repository<LedgerEntry>) {}

  findById(id: string): Promise<LedgerEntry | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<LedgerEntry>): Promise<LedgerEntry> {
    return this.repo.save(this.repo.create(data));
  }

  findByAccount(accountId: string, limit: number): Promise<LedgerEntry[]> {
    return this.repo.find({
      where: { accountId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
    });
  }
}
