import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { UserLimits } from '../../entities/user-limits.entity';
import { IUserLimitsRepository } from '../interfaces/user-limits.repository.interface';

/** TypeORM implementation of {@link IUserLimitsRepository}, bound to
 * `USER_LIMITS_REPOSITORY` in {@link PersistenceModule}. */
@Injectable()
export class UserLimitsRepository implements IUserLimitsRepository {
  constructor(@InjectRepository(UserLimits) private readonly repo: Repository<UserLimits>) {}

  findById(id: string): Promise<UserLimits | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<UserLimits>): Promise<UserLimits> {
    return this.repo.save(this.repo.create(data));
  }

  findByOwner(ownerId: string): Promise<UserLimits[]> {
    return this.repo.find({ where: { ownerId } });
  }
}
