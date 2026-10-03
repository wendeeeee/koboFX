import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';

export interface CurrencyPair {
  readonly sourceCurrency: string;
  readonly targetCurrency: string;
  readonly spreadBasisPoints: number;
  readonly minimumSourceAmountMinor: bigint;
  readonly isActive: boolean;
}

interface PairRow {
  source_currency_code: string;
  target_currency_code: string;
  spread_basis_points: number;
  minimum_source_amount_minor: string;
  is_active: boolean;
}

const COLUMNS = `source_currency_code, target_currency_code, spread_basis_points,
                 minimum_source_amount_minor::text AS minimum_source_amount_minor, is_active`;

function toPair(row: PairRow): CurrencyPair {
  return {
    sourceCurrency: row.source_currency_code.trim(),
    targetCurrency: row.target_currency_code.trim(),
    spreadBasisPoints: row.spread_basis_points,
    minimumSourceAmountMinor: BigInt(row.minimum_source_amount_minor),
    isActive: row.is_active,
  };
}

@Injectable()
export class CurrencyPairRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async find(sourceCurrency: string, targetCurrency: string): Promise<CurrencyPair | undefined> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS} FROM currency_pairs WHERE source_currency_code = $1 AND target_currency_code = $2`,
      [sourceCurrency, targetCurrency],
    )) as PairRow[];
    return row ? toPair(row) : undefined;
  }

  async active(): Promise<CurrencyPair[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS} FROM currency_pairs WHERE is_active ORDER BY source_currency_code, target_currency_code`,
    )) as PairRow[];
    return rows.map(toPair);
  }
}
