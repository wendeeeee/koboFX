import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';

export type DriftSource = 'internal' | 'external';

/**
 * Hooks for the reconciliation metrics of design §10. No metrics backend yet; a later phase
 * exports these.
 *
 * Pages: `reconciliation_drift_minor{currency,source} != 0` (money is wrong) and
 * `hash_chain_breaks_total > 0` (someone edited the database). Investigate, never page:
 * `accounts_overdrawn`, `reservations_overdue`, `reconciliation_breaks_open{type}`,
 * `clearing_balance_minor{currency}`.
 *
 * Drift and the finding counts are what THIS process's latest run measured (the run rows and
 * findings are the durable record); the open-break and CLEARING gauges are read from the
 * database, so they are right across processes.
 */
@Injectable()
export class ReconciliationMetrics {
  private readonly drift = new Map<string, bigint>();
  private hashChainBreaks = 0;
  private overdrawn = 0;
  private overdue = 0;

  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** Replace one source's drift gauge with a run's measurement (currencies never summed). */
  recordDrift(source: DriftSource, byCurrency: ReadonlyMap<string, bigint>): void {
    for (const key of [...this.drift.keys()]) if (key.endsWith(`|${source}`)) this.drift.delete(key);
    for (const [currency, minor] of byCurrency) this.drift.set(`${currency}|${source}`, minor);
  }

  /** `reconciliation_drift_minor{currency,source}`. */
  reconciliationDriftMinor(): { currency: string; source: DriftSource; driftMinor: bigint }[] {
    return [...this.drift.entries()]
      .map(([key, driftMinor]) => {
        const [currency, source] = key.split('|') as [string, DriftSource];
        return { currency, source, driftMinor };
      })
      .sort((a, b) => a.currency.localeCompare(b.currency) || a.source.localeCompare(b.source));
  }

  /** `hash_chain_breaks_total`: entries found broken, summed over this process's internal runs. */
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

  /** `accounts_overdrawn` (design §6.4: detect, never clamp) — from the latest internal run. */
  get accountsOverdrawn(): number {
    return this.overdrawn;
  }

  /** Check 4's overdue report (ACTIVE past `expires_at`) — from the latest internal run. */
  get reservationsOverdue(): number {
    return this.overdue;
  }

  /** `reconciliation_breaks_open{type,status}`: live breaks, from the database. */
  async breaksOpen(): Promise<{ type: string; status: string; count: number }[]> {
    return (await this.unitOfWork.manager.query(
      `SELECT type::text AS type, status::text AS status, count(*)::int AS count
         FROM reconciliation_breaks WHERE status <> 'RESOLVED'
        GROUP BY type, status ORDER BY type, status`,
    )) as { type: string; status: string; count: number }[];
  }

  /**
   * `clearing_balance_minor{currency}`: money we hold but cannot attribute (every bucket), as the
   * DEBIT-normal balance — an unattributed receipt (DR BANK / CR CLEARING) makes it NEGATIVE.
   * Anything other than 0 is to investigate.
   */
  async clearingBalanceMinor(): Promise<{ currency: string; balanceMinor: bigint }[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT currency_code AS currency, sum(balance_minor)::text AS balance
         FROM accounts WHERE code LIKE 'CLEARING:%' AND wallet_id IS NULL
        GROUP BY currency_code ORDER BY currency_code`,
    )) as { currency: string; balance: string }[];
    return rows.map((row) => ({ currency: row.currency, balanceMinor: BigInt(row.balance) }));
  }
}
