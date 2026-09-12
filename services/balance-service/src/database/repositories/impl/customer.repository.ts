import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, QueryRunner, Repository } from 'typeorm';
import { Customer } from '../../entities/customer.entity';
import { ICustomerRepository } from '../interfaces/customer.repository.interface';

/** TypeORM implementation of {@link ICustomerRepository}, bound to `CUSTOMER_REPOSITORY` in
 * {@link PersistenceModule}. No domain logic — persistence primitives only. */
@Injectable()
export class CustomerRepository implements ICustomerRepository {
  constructor(@InjectRepository(Customer) private readonly repo: Repository<Customer>) {}

  findById(id: string): Promise<Customer | null> {
    return this.repo.findOne({ where: { id } });
  }

  create(data: DeepPartial<Customer>): Promise<Customer> {
    return this.repo.save(this.repo.create(data));
  }

  async existsByIdInTx(queryRunner: QueryRunner, id: string): Promise<boolean> {
    const count = await queryRunner.manager
      .createQueryBuilder(Customer, 'customer')
      .where('customer.id = :id', { id })
      .getCount();
    return count > 0;
  }
}
