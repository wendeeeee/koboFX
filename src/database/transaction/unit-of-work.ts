import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { InvariantViolationError } from '../../common/errors';
import { translateDatabaseError } from '../database-errors';
import { registerUnitOfWork, unregisterUnitOfWork } from './transactional.decorator';

/**
 * The transaction boundary, carried implicitly through async calls (design §14).
 *
 * - `run()` opens ONE transaction at READ COMMITTED (design §6.6). Session timeouts
 *   (`lock_timeout`, `statement_timeout`) are set on every pooled connection.
 * - A nested `run()` joins the ambient transaction; it never opens a second one.
 *   A failure anywhere inside aborts the whole unit — there are no partial commits.
 * - Repositories read `manager`, so the same code works inside and outside a unit.
 *
 * Never call a third-party API inside `run()`: a DB transaction must not be held
 * open across a network call we don't control.
 */
@Injectable()
export class UnitOfWork implements OnModuleInit, OnModuleDestroy {
  private readonly storage = new AsyncLocalStorage<EntityManager>();

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit(): void {
    registerUnitOfWork(this);
  }

  onModuleDestroy(): void {
    unregisterUnitOfWork(this);
  }

  /** The ambient transactional manager, or the pool's manager outside a unit. */
  get manager(): EntityManager {
    return this.storage.getStore() ?? this.dataSource.manager;
  }

  get inTransaction(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /**
   * For code that must never run outside a transaction (the ledger, reservations).
   * Throws loudly rather than silently auto-committing statement by statement.
   */
  requireTransaction(): EntityManager {
    const manager = this.storage.getStore();
    if (!manager) {
      throw new InvariantViolationError('This operation must run inside a UnitOfWork transaction.');
    }
    return manager;
  }

  async run<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const ambient = this.storage.getStore();
    if (ambient) return work(ambient);
    try {
      return await this.dataSource.transaction('READ COMMITTED', (manager) =>
        this.storage.run(manager, () => work(manager)),
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
