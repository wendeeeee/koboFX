import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';

export type DriftSource = 'internal' | 'external';


@Injectable()
export class ReconciliationMetrics {
  private readonly drift = new Map<string, bigint>();
  private hashChainBreaks = 0;
  private overdrawn = 0;
  private overdue = 0;

  constructor(private readonly unitOfWork: UnitOfWork) {}

  recordDrift(source: DriftSource, byCurrency: ReadonlyMap<string, bigint>): void {
    for (const key of [...this.drift.keys()]) if (key.endsWith(`|${source}`)) this.drift.delete(key);
    for (const [currency, minor] of byCurrency) this.drift.set(`${currency}|${source}`, minor);
  }

  reconciliationDriftMinor(): { currency: string; source: DriftSource; driftMinor: bigint }[] {
    return [...this.drift.entries()]
      .map(([key, driftMinor]) => {
        const [currency, source] = key.split('|') as [string, DriftSource];
        return { currency, source, driftMinor };
      })
      .sort((a, b) => a.currency.localeCompare(b.currency) || a.source.localeCompare(b.source));
  }

  recordHashChainBreaks(count: number): void {
    this.hashChainBreaks += count;
  }

  get hashChainBreaksTotal(): number {
    return this.hashChainBreaks;
  }

  recordInternalFindings(counts: { accountsOverdrawn: number; reservationsOverdue: number }): void {
    this.overdrawn = counts.accountsOverdrawn;
    this.overdue = counts.reservationsOverdue;
  }

  get accountsOverdrawn(): number {
    return this.overdrawn;
  }

  get reservationsOverdue(): number {
    return this.overdue;
  }

  async breaksOpen(): Promise<{ type: string; status: string; count: number }[]> {
    return (await this.unitOfWork.manager.query(
      `SELECT type::text AS type, status::text AS status, count(*)::int AS count
         FROM reconciliation_breaks WHERE status <> 'RESOLVED'
        GROUP BY type, status ORDER BY type, status`,
    )) as { type: string; status: string; count: number }[];
  }

  async clearingBalanceMinor(): Promise<{ currency: string; balanceMinor: bigint }[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT currency_code AS currency, sum(balance_minor)::text AS balance
         FROM accounts WHERE code LIKE 'CLEARING:%' AND wallet_id IS NULL
        GROUP BY currency_code ORDER BY currency_code`,
    )) as { currency: string; balance: string }[];
    return rows.map((row) => ({ currency: row.currency, balanceMinor: BigInt(row.balance) }));
  }
}
