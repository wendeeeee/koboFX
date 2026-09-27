import { Test, TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { InvariantViolationError, UnsupportedCurrencyError } from '../../src/common/errors';
import { Money, parseMajorString, toMajorString } from '../../src/common/money';
import { ConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import { CurrenciesModule } from '../../src/modules/currencies/currencies.module';
import { CurrencyRegistry } from '../../src/modules/currencies/currency-registry';
import { TestDatabase, startTestDatabase } from '../support/test-database';

describe('CurrencyRegistry — minor units come from the database', () => {
  let db: TestDatabase;
  let moduleRef: TestingModule;
  let registry: CurrencyRegistry;
  let owner: Client;

  beforeAll(async () => {
    db = await startTestDatabase();
    owner = await db.ownerClient();
    // Currencies whose minor unit is NOT 2 — the case hardcoded `100` gets wrong.
    await owner.query(`
      INSERT INTO currencies (code, name, symbol, minor_unit, is_active) VALUES
        ('JPY', 'Japanese Yen',   '¥',  0, true),
        ('KWD', 'Kuwaiti Dinar',  'KD', 3, true),
        ('CHF', 'Swiss Franc',    'Fr', 2, false)
    `);
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(db.env), DatabaseModule, CurrenciesModule],
    }).compile();
    await moduleRef.init();
    registry = moduleRef.get(CurrencyRegistry);
  });

  afterAll(async () => {
    await owner?.end();
    await moduleRef?.close();
    await db?.stop();
  });

  it('loads the seeded set on bootstrap', () => {
    expect(registry.active().map((c) => c.code)).toEqual(['EUR', 'GBP', 'JPY', 'KWD', 'NGN', 'USD']);
    expect(registry.require('NGN')).toMatchObject({ code: 'NGN', minorUnit: 2, symbol: '₦' });
  });

  it.each([
    ['JPY', 0, 125n, '125'],
    ['KWD', 3, 1234n, '1.234'],
    ['NGN', 2, 125000n, '1250.00'],
  ])('%s has minor unit %d from the DB and formats %s as %s', (code, minorUnit, minor, major) => {
    const currency = registry.require(code);
    expect(currency.minorUnit).toBe(minorUnit);
    expect(Money.of(minor, code).toView(currency).amount).toBe(major);
    expect(parseMajorString(major, currency.minorUnit)).toBe(minor);
    expect(toMajorString(minor, currency.minorUnit)).toBe(major);
  });

  it('rejects unknown, malformed and inactive currencies at the boundary', () => {
    for (const code of ['XYZ', 'ngn', 'NG', '', 'CHF']) {
      expect(() => registry.require(code)).toThrow(UnsupportedCurrencyError);
      expect(registry.isSupported(code)).toBe(false);
    }
  });

  it('still describes an inactive currency, so historical records can be displayed', () => {
    expect(registry.lookup('CHF')).toMatchObject({ code: 'CHF', minorUnit: 2, isActive: false });
    expect(registry.lookup('XYZ')).toBeUndefined();
  });

  it('refresh() picks up changes, and refuses to run with no active currency', async () => {
    await owner.query(`UPDATE currencies SET is_active = true WHERE code = 'CHF'`);
    await registry.refresh();
    expect(registry.isSupported('CHF')).toBe(true);

    await owner.query(`UPDATE currencies SET is_active = false`);
    await expect(registry.refresh()).rejects.toThrow(InvariantViolationError);
    // The previous, valid set stays in force — a failed refresh never empties the registry.
    expect(registry.isSupported('NGN')).toBe(true);

    await owner.query(`UPDATE currencies SET is_active = true WHERE code <> 'CHF'`);
  });

  it('the schema enforces the ISO shape of the registry', async () => {
    await expect(
      owner.query(`INSERT INTO currencies (code, name, symbol, minor_unit) VALUES ('ABC', 'x', 'x', 5)`),
    ).rejects.toThrow(/check constraint/);
    await expect(
      owner.query(`INSERT INTO currencies (code, name, symbol, minor_unit) VALUES ('abc', 'x', 'x', 2)`),
    ).rejects.toThrow(/check constraint/);
  });
});
