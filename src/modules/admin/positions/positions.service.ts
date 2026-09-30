import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { RateTier, ageSeconds } from '../../fx/freshness';
import { FxRateService } from '../../fx/fx-rate.service';
import { LedgerChecksService } from '../../ledger/ledger-checks.service';
import { markBook } from './position-marking';

export interface PositionView {
  readonly currency: string;
  readonly minorUnit: number;
  /** `FX_POSITION` summed over buckets, in minor units; long positive (CREDIT-normal). */
  readonly position: string;
  /** Marked to the reference rate, USD minor units; null without a rate. */
  readonly markedUsd: string | null;
}

export interface TrialBalanceView {
  readonly currency: string;
  readonly debits: string;
  readonly credits: string;
  readonly balanced: boolean;
  readonly assets: string;
  readonly liabilities: string;
  readonly equity: string;
  readonly revenue: string;
  readonly expenses: string;
  readonly equationHolds: boolean;
}

export interface PositionsView {
  /** The snapshot the position is marked by — null when none exists. Stale or halted: still marked, flagged. */
  readonly markedBy: {
    readonly snapshotId: string;
    readonly provider: string;
    readonly asOf: string;
    readonly rateAgeSeconds: number;
    readonly tier: RateTier;
    readonly stale: boolean;
  } | null;
  readonly positions: readonly PositionView[];
  readonly totalMarkedUsd: string | null;
  readonly trialBalance: readonly TrialBalanceView[];
}

const USD = 'USD';

/**
 * `GET /admin/positions` (design §12, §15 item 2: "managing the position is treasury; this endpoint surfaces it").
 * Read-only, no provider call (the rate is what the read path already holds). A stale or halted rate still marks
 * the book — treasury needs the number most exactly when the feed is in trouble — flagged `stale`.
 */
@Injectable()
export class PositionsService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly rates: FxRateService,
    private readonly checks: LedgerChecksService,
  ) {}

  async positions(): Promise<PositionsView> {
    const served = await this.rates.current();
    const rows = (await this.unitOfWork.manager.query(
      `SELECT currencies.code AS currency, currencies.minor_unit, COALESCE(sum(accounts.balance_minor), 0)::text AS position_minor
         FROM currencies
         LEFT JOIN accounts ON accounts.currency_code = currencies.code AND accounts.wallet_id IS NULL
                           AND accounts.code = 'FX_POSITION:' || currencies.code
        WHERE currencies.is_active
        GROUP BY currencies.code, currencies.minor_unit
        ORDER BY currencies.code`,
    )) as { currency: string; minor_unit: number; position_minor: string }[];
    const usdMinorUnit = rows.find((row) => row.currency.trim() === USD)?.minor_unit ?? 2;
    const book = markBook(
      rows.map((row) => ({
        currency: row.currency.trim(),
        minorUnit: row.minor_unit,
        positionMinor: BigInt(row.position_minor),
        usdRate: served?.snapshot.rates.get(row.currency.trim()),
      })),
      usdMinorUnit,
    );

    const [trial, equation] = await Promise.all([this.checks.trialBalance(), this.checks.accountingEquation()]);
    const equationByCurrency = new Map(equation.map((line) => [line.currency, line]));
    return {
      markedBy: served
        ? {
            snapshotId: served.snapshot.id,
            provider: served.snapshot.provider,
            asOf: served.snapshot.providerUpdatedAt.toISOString(),
            rateAgeSeconds: ageSeconds(served.freshness),
            tier: served.freshness.tier,
            stale: served.freshness.tier !== RateTier.EXECUTABLE,
          }
        : null,
      positions: book.positions.map((position) => ({
        currency: position.currency,
        minorUnit: position.minorUnit,
        position: position.positionMinor.toString(),
        markedUsd: position.markedUsdMinor?.toString() ?? null,
      })),
      totalMarkedUsd: book.totalMarkedUsdMinor?.toString() ?? null,
      trialBalance: trial.map((line) => {
        const accounting = equationByCurrency.get(line.currency);
        return {
          currency: line.currency,
          debits: line.debitTotalMinor.toString(),
          credits: line.creditTotalMinor.toString(),
          balanced: line.balanced,
          assets: (accounting?.assetsMinor ?? 0n).toString(),
          liabilities: (accounting?.liabilitiesMinor ?? 0n).toString(),
          equity: (accounting?.equityMinor ?? 0n).toString(),
          revenue: (accounting?.revenueMinor ?? 0n).toString(),
          expenses: (accounting?.expensesMinor ?? 0n).toString(),
          equationHolds: accounting?.holds ?? true,
        };
      }),
    };
  }
}
