import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { Hold } from '../../entities/hold.entity';
import { IHoldRepository } from '../interfaces/hold.repository.interface';

/** TypeORM implementation of {@link IHoldRepository}, bound to `HOLD_REPOSITORY` in
 * {@link PersistenceModule}. */
@Injectable()
export class HoldRepository implements IHoldRepository {
  constructor(@InjectRepository(Hold) private readonly repo: Repository<Hold>) {}

  findById(id: string): Promise<Hold | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<Hold>): Promise<Hold> {
    return this.repo.save(this.repo.create(data));
  }
}
