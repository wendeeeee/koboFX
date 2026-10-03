import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InvariantViolationError, UnsupportedCurrencyError } from '../../common/errors';
import { CURRENCY_CODE_PATTERN, Currency, assertMinorUnit } from '../../common/money';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { CurrencyEntity } from './currency.entity';

/**
 * The controlled currency set loaded from the `currencies` table.
 */
@Injectable()
export class CurrencyRegistry implements OnApplicationBootstrap {
  private byCode = new Map<string, Currency>();

  constructor(private readonly unitOfWork: UnitOfWork) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const rows = await this.unitOfWork.manager.find(CurrencyEntity, { order: { code: 'ASC' } });
    const next = new Map<string, Currency>();
    for (const row of rows) {
      assertMinorUnit(row.minorUnit);
      next.set(row.code, Object.freeze({
        code: row.code,
        name: row.name,
        symbol: row.symbol,
        minorUnit: row.minorUnit,
        isActive: row.isActive,
      }));
    }
    if (![...next.values()].some((c) => c.isActive)) {
      throw new InvariantViolationError('No active currencies configured; refusing to start.');
    }
    this.byCode = next;
  }

  require(code: string): Currency {
    const currency = this.lookup(code);
    if (!currency?.isActive) throw new UnsupportedCurrencyError(code);
    return currency;
  }

  lookup(code: string): Currency | undefined {
    if (typeof code !== 'string' || !CURRENCY_CODE_PATTERN.test(code)) return undefined;
    return this.byCode.get(code);
  }

  isSupported(code: string): boolean {
    return this.lookup(code)?.isActive === true;
  }

  active(): Currency[] {
    return [...this.byCode.values()].filter((c) => c.isActive);
  }
}
