import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { dec } from '../../common/money/decimal';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { exactRateString, triangulatedMid } from '../fx/pricing';
import { LedgerChecksService, LedgerIntegrityReport } from '../ledger/ledger-checks.service';
import { ReservationChecksService, ReservationIntegrityReport } from '../reservations/reservation-checks.service';
import { assertRateDisplayReproduces, rateDisplayOf } from '../trading/conversion-posting';
import { BREAK_POLICIES, BreakType, subjectKeys } from './break-types';
import { BreakCandidate, BreakService } from './break.service';
import { DriftContribution, currencyOfAccountCode, driftByCurrency } from './drift';
import { ReconciliationCheckpoint, ReconciliationCheckpoints } from './reconciliation-checkpoints';
import { ReconciliationMetrics } from './reconciliation-metrics';
import { ClaimedRun, ReconciliationRunRepository, ReconciliationRunStatus } from './reconciliation-run.repository';

/** A conversion whose recorded provenance does not reproduce from its own snapshot (Phase 9 §H.10). */
export interface FxProvenanceMismatch {
  readonly transactionId: string;
  readonly currency: string;
  readonly problem: 'SNAPSHOT_RATE_MISSING' | 'REFERENCE_RATE_MISMATCH' | 'RATE_DISPLAY_MISMATCH';
  readonly detail: Record<string, string>;
}

/** Everything one snapshot measured. */
export interface InternalMeasurement {
  readonly snapshotAt: Date;
  readonly ledger: LedgerIntegrityReport;
  readonly reservations: ReservationIntegrityReport;
  readonly fxMismatches: readonly FxProvenanceMismatch[];
  /** Account id → currency, for every account a finding names. */
  readonly accountCurrencies: ReadonlyMap<string, string>;
  readonly currencies: readonly string[];
}

export interface InternalRunResult {
  readonly runId: string;
  readonly status: ReconciliationRunStatus.CLEAN | ReconciliationRunStatus.BREAKS_FOUND;
  readonly drift: ReadonlyMap<string, bigint>;
  readonly breakIds: readonly string[];
  readonly hashChainBreaks: number;
  readonly findingCount: number;
}

interface Finding {
  readonly kind: string;
  readonly currency: string | null;
  readonly subject: string;
  readonly measured: Record<string, unknown>;
  readonly driftMinor: bigint;
  readonly candidate: BreakCandidate | null;
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * Internal reconciliation — the books against themselves (design §8.1), nightly.
 *
 * 1. ONE `REPEATABLE READ READ ONLY` snapshot, with the job's own statement timeout (Phase 9
 *    §H.7): the six checks of `LedgerChecksService` / `ReservationChecksService`, UNCHANGED, plus
 *    the FX provenance check. One snapshot ⇒ a posting that commits mid-run cannot produce a
 *    false "cached balance ≠ Σ entries".
 * 2. ONE writing transaction: every violation as a finding; the money-is-wrong ones as breaks
 *    (escalated — only a Phase 10 CORRECTION or forensics resolves them); live internal breaks
 *    this run no longer sees are annotated, never resolved; the run is finished CLEAN or
 *    BREAKS_FOUND. A crash anywhere before that commit leaves nothing: the run is redone.
 * 3. Metrics: drift per currency, hash-chain breaks, overdrafts, the overdue report.
 */
@Injectable()
export class InternalReconciliationJob {
  private readonly logger = new Logger(InternalReconciliationJob.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ledgerChecks: LedgerChecksService,
    private readonly reservationChecks: ReservationChecksService,
    private readonly breaks: BreakService,
    private readonly runs: ReconciliationRunRepository,
    private readonly metrics: ReconciliationMetrics,
    private readonly checkpoints: ReconciliationCheckpoints,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async run(run: ClaimedRun): Promise<InternalRunResult> {
    const started = Date.now();
    const measurement = await this.measure();
    await this.checkpoints.reached(ReconciliationCheckpoint.AFTER_SNAPSHOT, { runId: run.id, kind: run.kind });

    const findings = this.findingsOf(measurement);
    const drift = driftByCurrency(
      findings.filter((finding) => finding.currency !== null && finding.driftMinor > 0n).map(
        (finding): DriftContribution => ({ currency: finding.currency as string, differenceMinor: finding.driftMinor }),
      ),
      measurement.currencies,
    );
    const hashChainBreaks = measurement.ledger.hashChainBreaks.length;
    const breakIds = new Set<string>();

    await this.unitOfWork.run(async (manager) => {
      for (const finding of findings) {
        const breakId = finding.candidate ? (await this.breaks.detect(run.id, finding.candidate)).breakId : null;
        if (breakId) breakIds.add(breakId);
        await manager.query(
          `INSERT INTO reconciliation_findings (run_id, kind, currency_code, subject, measured, drift_minor, break_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [run.id, finding.kind, finding.currency, finding.subject, JSON.stringify(finding.measured), finding.driftMinor.toString(), breakId],
        );
      }
      await this.annotateNoLongerDetected(run, breakIds);
      const summary = {
        clean: breakIds.size === 0,
        snapshotAt: measurement.snapshotAt.toISOString(),
        durationMilliseconds: Date.now() - started,
        findings: countBy(findings.map((finding) => finding.kind)),
        breaks: breakIds.size,
        driftMinor: Object.fromEntries([...drift.entries()].map(([currency, minor]) => [currency, minor.toString()])),
        hashChainBreaks,
        accountsOverdrawn: measurement.ledger.overdrawnAccounts.length,
        reservationsOverdue: measurement.reservations.overdueReservations.length,
      };
      await this.checkpoints.reached(ReconciliationCheckpoint.BEFORE_COMMIT, { runId: run.id, kind: run.kind });
      await this.runs.finish(
        run,
        breakIds.size === 0 ? ReconciliationRunStatus.CLEAN : ReconciliationRunStatus.BREAKS_FOUND,
        summary,
        measurement.snapshotAt,
      );
    });

    this.metrics.recordDrift('internal', drift);
    this.metrics.recordHashChainBreaks(hashChainBreaks);
    this.metrics.recordInternalFindings({
      accountsOverdrawn: measurement.ledger.overdrawnAccounts.length,
      reservationsOverdue: measurement.reservations.overdueReservations.length,
    });
    const status = breakIds.size === 0 ? ReconciliationRunStatus.CLEAN : ReconciliationRunStatus.BREAKS_FOUND;
    const log = { runId: run.id, periodKey: run.periodKey, status, findings: findings.length, breaks: breakIds.size, hashChainBreaks };
    if (breakIds.size === 0) this.logger.log(log, 'Internal reconciliation finished');
    else this.logger.error(log, 'Internal reconciliation found breaks: money may be wrong');
    return { runId: run.id, status, drift, breakIds: [...breakIds], hashChainBreaks, findingCount: findings.length };
  }

  /** The read-only half: every check, one snapshot. Public so tests can prove its consistency. */
  async measure(): Promise<InternalMeasurement> {
    return this.unitOfWork.runReadOnlySnapshot(
      async (manager) => {
        const [{ snapshot_at: snapshotAt }] = (await manager.query(`SELECT now() AS snapshot_at`)) as { snapshot_at: Date }[];
        const ledger = await this.ledgerChecks.runAllChecks();
        const reservations = await this.reservationChecks.runAllChecks();
        const fxMismatches = await this.fxProvenanceMismatches(manager);
        const accountIds = [
          ...ledger.balanceContinuityBreaks.map((finding) => finding.accountId),
          ...ledger.hashChainBreaks.map((finding) => finding.accountId),
        ];
        const accountRows = (await manager.query(`SELECT id, currency_code FROM accounts WHERE id = ANY($1::uuid[])`, [
          [...new Set(accountIds)],
        ])) as { id: string; currency_code: string }[];
        const currencyRows = (await manager.query(`SELECT code FROM currencies WHERE is_active ORDER BY code`)) as { code: string }[];
        return {
          snapshotAt,
          ledger,
          reservations,
          fxMismatches,
          accountCurrencies: new Map(accountRows.map((row) => [row.id, row.currency_code])),
          currencies: currencyRows.map((row) => row.code),
        };
      },
      { statementTimeoutMilliseconds: this.config.reconciliation.statementTimeoutSeconds * 1000 },
    );
  }

  /**
   * Every CONVERSION re-derived from its own snapshot, locally (zero provider budget): the
   * reference rate is the triangulated mid of the snapshot's two USD rates, and the display rate
   * is derived from — and reproduces — the posted amounts.
   */
  private async fxProvenanceMismatches(manager: EntityManager): Promise<FxProvenanceMismatch[]> {
    const rows = (await manager.query(
      `SELECT transactions.id, transactions.source_currency, transactions.target_currency,
              transactions.source_amount_minor::text AS source_amount_minor,
              transactions.target_amount_minor::text AS target_amount_minor,
              transactions.rate_display::text AS rate_display, transactions.reference_rate::text AS reference_rate,
              source_currency.minor_unit AS source_minor_unit, target_currency.minor_unit AS target_minor_unit,
              source_rate.rate::text AS source_usd_rate, target_rate.rate::text AS target_usd_rate
         FROM transactions
         JOIN currencies AS source_currency ON source_currency.code = transactions.source_currency
         JOIN currencies AS target_currency ON target_currency.code = transactions.target_currency
         LEFT JOIN exchange_rate_snapshot_rates AS source_rate
           ON source_rate.snapshot_id = transactions.rate_snapshot_id AND source_rate.currency_code = transactions.source_currency
         LEFT JOIN exchange_rate_snapshot_rates AS target_rate
           ON target_rate.snapshot_id = transactions.rate_snapshot_id AND target_rate.currency_code = transactions.target_currency
        WHERE transactions.type = 'CONVERSION'
        ORDER BY transactions.booking_time, transactions.id`,
    )) as {
      id: string;
      source_currency: string;
      target_currency: string;
      source_amount_minor: string;
      target_amount_minor: string;
      rate_display: string;
      reference_rate: string;
      source_minor_unit: number;
      target_minor_unit: number;
      source_usd_rate: string | null;
      target_usd_rate: string | null;
    }[];
    const mismatches: FxProvenanceMismatch[] = [];
    for (const row of rows) {
      const base = { transactionId: row.id, currency: row.target_currency };
      if (row.source_usd_rate === null || row.target_usd_rate === null) {
        mismatches.push({ ...base, problem: 'SNAPSHOT_RATE_MISSING', detail: { sourceCurrency: row.source_currency, targetCurrency: row.target_currency } });
        continue;
      }
      const mid = exactRateString(triangulatedMid(dec(row.source_usd_rate), dec(row.target_usd_rate)));
      if (!dec(mid).eq(dec(row.reference_rate))) {
        mismatches.push({ ...base, problem: 'REFERENCE_RATE_MISMATCH', detail: { recordedReferenceRate: row.reference_rate, snapshotMid: mid } });
        continue;
      }
      const source = { code: row.source_currency, minorUnit: row.source_minor_unit };
      const target = { code: row.target_currency, minorUnit: row.target_minor_unit };
      const sourceAmount = BigInt(row.source_amount_minor);
      const targetAmount = BigInt(row.target_amount_minor);
      const derived = rateDisplayOf(source, sourceAmount, target, targetAmount);
      let reproduces = dec(derived).eq(dec(row.rate_display));
      if (reproduces) {
        try {
          assertRateDisplayReproduces(row.rate_display, source, sourceAmount, target, targetAmount);
        } catch {
          reproduces = false;
        }
      }
      if (!reproduces) {
        mismatches.push({ ...base, problem: 'RATE_DISPLAY_MISMATCH', detail: { recordedRateDisplay: row.rate_display, derivedRateDisplay: derived } });
      }
    }
    return mismatches;
  }

  private findingsOf(measurement: InternalMeasurement): Finding[] {
    const { ledger, reservations } = measurement;
    const findings: Finding[] = [];
    const money = (type: BreakType, subjectKey: string, currency: string | null, amountMinor: bigint, extra: Partial<BreakCandidate>, details: Record<string, string | number | boolean | null>): BreakCandidate => ({
      type,
      subjectKey,
      currency,
      amountMinor,
      details,
      ...extra,
    });

    for (const line of ledger.unbalancedCurrencies) {
      const difference = absolute(line.debitTotalMinor - line.creditTotalMinor);
      const details = { debitTotalMinor: line.debitTotalMinor.toString(), creditTotalMinor: line.creditTotalMinor.toString() };
      findings.push({
        kind: 'TRIAL_BALANCE',
        currency: line.currency,
        subject: subjectKeys.currency(line.currency),
        measured: details,
        driftMinor: difference,
        candidate: money(BreakType.TRIAL_BALANCE_UNBALANCED, subjectKeys.currency(line.currency), line.currency, difference, {}, details),
      });
    }
    for (const line of ledger.accountingEquationFailures) {
      const difference = absolute(line.assetsMinor - (line.liabilitiesMinor + line.equityMinor + line.revenueMinor - line.expensesMinor));
      const details = {
        assetsMinor: line.assetsMinor.toString(),
        liabilitiesMinor: line.liabilitiesMinor.toString(),
        equityMinor: line.equityMinor.toString(),
        revenueMinor: line.revenueMinor.toString(),
        expensesMinor: line.expensesMinor.toString(),
      };
      findings.push({
        kind: 'ACCOUNTING_EQUATION',
        currency: line.currency,
        subject: subjectKeys.currency(line.currency),
        measured: details,
        driftMinor: difference,
        candidate: money(BreakType.ACCOUNTING_EQUATION_FAILED, subjectKeys.currency(line.currency), line.currency, difference, {}, details),
      });
    }
    for (const mismatch of ledger.cachedBalanceMismatches) {
      const currency = currencyOfAccountCode(mismatch.code);
      const difference = absolute(mismatch.cachedBalanceMinor - mismatch.entriesBalanceMinor);
      const details = {
        cachedBalanceMinor: mismatch.cachedBalanceMinor.toString(),
        entriesBalanceMinor: mismatch.entriesBalanceMinor.toString(),
        cachedBalanceEntryId: mismatch.cachedBalanceEntryId?.toString() ?? null,
        lastEntryId: mismatch.lastEntryId?.toString() ?? null,
      };
      findings.push({
        kind: 'CACHED_BALANCE',
        currency,
        subject: subjectKeys.account(mismatch.accountId),
        measured: details,
        driftMinor: difference,
        candidate: money(BreakType.CACHED_BALANCE_DRIFT, subjectKeys.account(mismatch.accountId), currency, difference, { ledgerAccountId: mismatch.accountId }, details),
      });
    }
    const continuityByAccount = new Map<string, { difference: bigint; firstEntryId: bigint; count: number }>();
    for (const entry of ledger.balanceContinuityBreaks) {
      const currency = measurement.accountCurrencies.get(entry.accountId) ?? null;
      const difference = absolute(entry.balanceAfterMinor - entry.expectedBalanceAfterMinor);
      findings.push({
        kind: 'BALANCE_CONTINUITY',
        currency,
        subject: `entry:${entry.entryId.toString()}`,
        measured: { accountId: entry.accountId, balanceAfterMinor: entry.balanceAfterMinor.toString(), expectedBalanceAfterMinor: entry.expectedBalanceAfterMinor.toString() },
        driftMinor: difference,
        candidate: null,
      });
      const aggregate = continuityByAccount.get(entry.accountId) ?? { difference: 0n, firstEntryId: entry.entryId, count: 0 };
      continuityByAccount.set(entry.accountId, { difference: aggregate.difference + difference, firstEntryId: aggregate.firstEntryId, count: aggregate.count + 1 });
    }
    for (const [accountId, aggregate] of continuityByAccount) {
      const currency = measurement.accountCurrencies.get(accountId) ?? null;
      const details = { firstBrokenEntryId: aggregate.firstEntryId.toString(), brokenEntries: aggregate.count };
      findings.push({
        kind: 'BALANCE_CONTINUITY_ACCOUNT',
        currency,
        subject: subjectKeys.account(accountId),
        measured: details,
        driftMinor: 0n,
        candidate: money(BreakType.BALANCE_CONTINUITY_BREAK, subjectKeys.account(accountId), currency, aggregate.difference, { ledgerAccountId: accountId }, details),
      });
    }
    const chainByAccount = new Map<string, { firstEntryId: bigint; count: number }>();
    for (const entry of ledger.hashChainBreaks) {
      findings.push({
        kind: 'HASH_CHAIN',
        currency: measurement.accountCurrencies.get(entry.accountId) ?? null,
        subject: `entry:${entry.entryId.toString()}`,
        measured: { accountId: entry.accountId, faults: entry.faults },
        driftMinor: 0n,
        candidate: null,
      });
      const aggregate = chainByAccount.get(entry.accountId) ?? { firstEntryId: entry.entryId, count: 0 };
      chainByAccount.set(entry.accountId, { firstEntryId: aggregate.firstEntryId, count: aggregate.count + 1 });
    }
    for (const [accountId, aggregate] of chainByAccount) {
      const currency = measurement.accountCurrencies.get(accountId) ?? null;
      const details = { firstBrokenEntryId: aggregate.firstEntryId.toString(), brokenEntries: aggregate.count };
      findings.push({
        kind: 'HASH_CHAIN_ACCOUNT',
        currency,
        subject: subjectKeys.account(accountId),
        measured: details,
        driftMinor: 0n,
        candidate: money(BreakType.HASH_CHAIN_BREAK, subjectKeys.account(accountId), currency, 0n, { ledgerAccountId: accountId }, details),
      });
    }
    for (const mismatch of reservations.reservedBalanceMismatches) {
      const currency = currencyOfAccountCode(mismatch.code);
      const difference = absolute(mismatch.reservedMinor - mismatch.activeReservationsMinor);
      const details = { reservedMinor: mismatch.reservedMinor.toString(), activeReservationsMinor: mismatch.activeReservationsMinor.toString() };
      findings.push({
        kind: 'RESERVED_BALANCE',
        currency,
        subject: subjectKeys.account(mismatch.accountId),
        measured: details,
        driftMinor: difference,
        candidate: money(BreakType.RESERVED_BALANCE_DRIFT, subjectKeys.account(mismatch.accountId), currency, difference, { ledgerAccountId: mismatch.accountId }, details),
      });
    }
    for (const mismatch of measurement.fxMismatches) {
      const details = { problem: mismatch.problem, ...mismatch.detail };
      findings.push({
        kind: 'FX_PROVENANCE',
        currency: mismatch.currency,
        subject: subjectKeys.transaction(mismatch.transactionId),
        measured: details,
        driftMinor: 0n,
        candidate: money(BreakType.FX_PROVENANCE_MISMATCH, subjectKeys.transaction(mismatch.transactionId), mismatch.currency, 0n, {}, details),
      });
    }
    // Reports, not breaks: an overdraft is a state to investigate (design §6.4); an overdue
    // reservation is liveness — money locked, never wrong (Phase 3 decision 11).
    for (const account of ledger.overdrawnAccounts) {
      findings.push({
        kind: 'OVERDRAWN_ACCOUNT',
        currency: account.currency,
        subject: subjectKeys.account(account.accountId),
        measured: { balanceMinor: account.balanceMinor.toString(), overdraftLimitMinor: account.overdraftLimitMinor.toString() },
        driftMinor: 0n,
        candidate: null,
      });
    }
    for (const reservation of reservations.overdueReservations) {
      findings.push({
        kind: 'OVERDUE_RESERVATION',
        currency: null,
        subject: `reservation:${reservation.reservationId}`,
        measured: { accountId: reservation.accountId, flowId: reservation.flowId, amountMinor: reservation.amountMinor.toString(), expiresAt: reservation.expiresAt.toISOString() },
        driftMinor: 0n,
        candidate: null,
      });
    }
    return findings;
  }

  /**
   * Live internal breaks this run did not see again: the books no longer show the problem, but
   * nothing NAMED a cause (only an approved CORRECTION would be one — Phase 10). They are left
   * live and annotated; "it went away" is not a resolution.
   */
  private async annotateNoLongerDetected(run: ClaimedRun, seen: ReadonlySet<string>): Promise<void> {
    const types = (Object.keys(BREAK_POLICIES) as BreakType[]).filter((type) => BREAK_POLICIES[type].rederivedBy === 'INTERNAL');
    for (const live of await this.breaks.live(types)) {
      if (seen.has(live.id)) continue;
      await this.breaks.annotate(live.id, `No longer detected by internal run ${run.id} (${run.periodKey}); not resolved: no cause was named.`);
    }
  }
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
