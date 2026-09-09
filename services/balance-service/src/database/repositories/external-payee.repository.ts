import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { ExternalPayee } from '../entities/external-payee.entity';
import { IExternalPayeeRepository } from './external-payee.repository.interface';

/** TypeORM implementation of {@link IExternalPayeeRepository}, bound to
 * `EXTERNAL_PAYEE_REPOSITORY` in {@link PersistenceModule}. */
@Injectable()
export class ExternalPayeeRepository implements IExternalPayeeRepository {
  constructor(@InjectRepository(ExternalPayee) private readonly repo: Repository<ExternalPayee>) {}

  findById(id: string): Promise<ExternalPayee | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<ExternalPayee>): Promise<ExternalPayee> {
    return this.repo.save(this.repo.create(data));
  }

  findByOwner(ownerId: string): Promise<ExternalPayee[]> {
    return this.repo.find({ where: { ownerId } });
  }
}
