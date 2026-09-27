import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import fc from 'fast-check';
import { DataSource, EntityManager } from 'typeorm';
import { InvariantViolationError, ResourceBusyError } from '../../src/common/errors';
import { INT64_MAX, INT64_MIN } from '../../src/common/money';
import { ConfigModule } from '../../src/config/config.module';
import { bigintTransformer } from '../../src/database/bigint.transformer';
import { DatabaseModule } from '../../src/database/database.module';
import { Transactional } from '../../src/database/transaction/transactional.decorator';
import { UnitOfWork } from '../../src/database/transaction/unit-of-work';
import { TestDatabase, startTestDatabase } from '../support/test-database';

@Injectable()
class ProbeService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  @Transactional()
  async insideDecorated(): Promise<{ inTransaction: boolean; manager: EntityManager }> {
    return { inTransaction: this.unitOfWork.inTransaction, manager: this.unitOfWork.manager };
  }
}

async function currencyExists(manager: EntityManager, code: string): Promise<boolean> {
  const rows: unknown[] = await manager.query('SELECT 1 FROM currencies WHERE code = $1', [code]);
  return rows.length === 1;
}

async function insertCurrency(manager: EntityManager, code: string): Promise<void> {
  await manager.query(
    `INSERT INTO currencies (code, name, symbol, minor_unit, is_active) VALUES ($1, $2, $3, 2, false)`,
    [code, `Test ${code}`, code],
  );
}

describe('Database foundations (real Postgres 16)', () => {
  let db: TestDatabase;
  let moduleRef: TestingModule;
  let unitOfWork: UnitOfWork;
  let dataSource: DataSource;

  beforeAll(async () => {
    // A short lock timeout keeps the timeout test fast; the mechanism is the same as 3s.
    db = await startTestDatabase({ DB_LOCK_TIMEOUT_MS: '300' });
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(db.env), DatabaseModule],
      providers: [ProbeService],
    }).compile();
    await moduleRef.init();
    unitOfWork = moduleRef.get(UnitOfWork);
    dataSource = moduleRef.get(DataSource);
  });

  afterAll(async () => {
    await moduleRef?.close();
    await db?.stop();
  });

  describe('roles: the app cannot change the schema', () => {
    it('connects as fx_app, not as the owner', async () => {
      const [row] = await dataSource.query('SELECT current_user AS who');
      expect(row.who).toBe('fx_app');
    });

    it('fx_app is denied DDL', async () => {
      await expect(dataSource.query('CREATE TABLE sneaky (id int)')).rejects.toThrow(/permission denied/);
      await expect(dataSource.query('DROP TABLE currencies')).rejects.toThrow(/must be owner/);
    });

    it('fx_app has DML on migrated tables via default privileges', async () => {
      const rows = await dataSource.query('SELECT code FROM currencies ORDER BY code');
      expect(rows.map((r: { code: string }) => r.code)).toEqual(['EUR', 'GBP', 'NGN', 'USD']);
    });
  });

  describe('session settings on every pooled connection (design §6.6)', () => {
    it('sets lock_timeout, statement_timeout and UTC', async () => {
      const [lock] = await dataSource.query('SHOW lock_timeout');
      const [stmt] = await dataSource.query('SHOW statement_timeout');
      const [tz] = await dataSource.query('SHOW TimeZone');
      expect(lock.lock_timeout).toBe('300ms');
      expect(stmt.statement_timeout).toBe('10s');
      expect(tz.TimeZone).toBe('UTC');
    });

    it('runs units of work at READ COMMITTED', async () => {
      const level = await unitOfWork.run(async (m) => {
        const [row] = await m.query('SHOW transaction_isolation');
        return row.transaction_isolation;
      });
      expect(level).toBe('read committed');
    });
  });

  describe('BIGINT round-trips exactly through Postgres', () => {
    it('for any int64 value, including beyond Number.MAX_SAFE_INTEGER', async () => {
      const boundary = [INT64_MIN, INT64_MAX, 9007199254740993n, -9007199254740993n, 0n];
      const sampled = fc.sample(fc.bigInt({ min: INT64_MIN, max: INT64_MAX }), 200);
      for (const value of [...boundary, ...sampled]) {
        const [row] = await dataSource.query('SELECT $1::bigint AS v', [bigintTransformer.to(value)]);
        expect(typeof row.v).toBe('string');
        expect(bigintTransformer.from(row.v)).toBe(value);
      }
    });

    it('NUMERIC(24,12) rates come back as exact strings, never floats', async () => {
      const [row] = await dataSource.query(`SELECT '1530.500000000001'::numeric(24,12) AS r`);
      expect(row.r).toBe('1530.500000000001');
    });
  });

  describe('UnitOfWork', () => {
    it('commits on success', async () => {
      await unitOfWork.run((m) => insertCurrency(m, 'TCA'));
      expect(await currencyExists(dataSource.manager, 'TCA')).toBe(true);
    });

    it('rolls back everything on failure — no partial writes', async () => {
      await expect(
        unitOfWork.run(async (m) => {
          await insertCurrency(m, 'TCB');
          throw new Error('boom after the write');
        }),
      ).rejects.toThrow('boom after the write');
      expect(await currencyExists(dataSource.manager, 'TCB')).toBe(false);
    });

    it('a nested run joins the ambient transaction; an inner failure aborts the whole unit', async () => {
      let outer: EntityManager | undefined;
      let inner: EntityManager | undefined;
      await expect(
        unitOfWork.run(async (m) => {
          outer = m;
          await insertCurrency(m, 'TCC');
          await unitOfWork.run(async (n) => {
            inner = n;
            throw new Error('inner failure');
          });
        }),
      ).rejects.toThrow('inner failure');
      expect(inner).toBe(outer);
      expect(await currencyExists(dataSource.manager, 'TCC')).toBe(false);
    });

    it('propagates the ambient manager through async boundaries', async () => {
      await unitOfWork.run(async (m) => {
        await new Promise((resolve) => setImmediate(resolve));
        await Promise.all([1, 2].map(async () => expect(unitOfWork.manager).toBe(m)));
      });
      expect(unitOfWork.inTransaction).toBe(false);
    });

    it('requireTransaction() refuses to run outside a unit', async () => {
      expect(() => unitOfWork.requireTransaction()).toThrow(InvariantViolationError);
      await unitOfWork.run(async (m) => expect(unitOfWork.requireTransaction()).toBe(m));
    });

    it('@Transactional() methods run inside a unit', async () => {
      const probe = moduleRef.get(ProbeService);
      const result = await probe.insideDecorated();
      expect(result.inTransaction).toBe(true);
      expect(result.manager).not.toBe(dataSource.manager);
    });

    it('a lock wait past lock_timeout becomes RESOURCE_BUSY (503), not a hung connection', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));

      const holder = unitOfWork.run(async (m) => {
        await m.query(`SELECT code FROM currencies WHERE code = 'NGN' FOR UPDATE`);
        locked();
        await held;
      });
      await isLocked;

      // A second, independent unit: separate async context, separate connection.
      const started = Date.now();
      const contender = new Promise<unknown>((resolve) =>
        setImmediate(() =>
          unitOfWork
            .run((m) => m.query(`SELECT code FROM currencies WHERE code = 'NGN' FOR UPDATE`))
            .then(resolve, resolve),
        ),
      );
      const outcome = await contender;
      release();
      await holder;

      expect(outcome).toBeInstanceOf(ResourceBusyError);
      expect((outcome as ResourceBusyError).details).toEqual({ reason: 'lock_timeout' });
      expect((outcome as ResourceBusyError).permanent).toBe(false);
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });
});
