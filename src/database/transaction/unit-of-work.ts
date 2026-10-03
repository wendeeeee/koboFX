import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { InvariantViolationError } from '../../common/errors';
import { translateDatabaseError } from '../database-errors';
import { registerUnitOfWork, unregisterUnitOfWork } from './transactional.decorator';

/**
 * - This is the transaction boundary, carried implicitly through async calls.
 * - `run()` opens ONE transaction at READ COMMITTED. Session timeouts
 *   (`lock_timeout`, `statement_timeout`) are set on every pooled connection.
 * - A nested `run()` joins the ambient transaction; it never opens a second one.
 * - A failure anywhere inside aborts the whole unit, there are no partial commits.
 * - Repositories read `manager`, so the same code works inside and outside a unit.
 * -`run()` is never called across a network call to a third-party API
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

  /**
   * ONE `REPEATABLE READ READ ONLY` transaction: every statement inside sees the same snapshot,
   * so a check made of several queries cannot be fooled by a posting that commits between two
   * of them.
   */
  async runReadOnlySnapshot<T>(work: (manager: EntityManager) => Promise<T>, options: { statementTimeoutMilliseconds: number }): Promise<T> {
    if (this.storage.getStore()) {
      throw new InvariantViolationError('A read-only snapshot cannot join an ambient transaction.');
    }
    const timeout = Math.trunc(options.statementTimeoutMilliseconds);
    if (!Number.isInteger(timeout) || timeout <= 0) throw new InvariantViolationError('A snapshot needs a positive statement timeout.');
    try {
      return await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        await manager.query(`SET LOCAL statement_timeout = ${timeout}`);
        return this.storage.run(manager, () => work(manager));
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
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
