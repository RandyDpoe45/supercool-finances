import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
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
}
