import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../../common/clock';
import { Dec, dec } from '../../../common/money';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../../audit/audit-log.service';
import {
  ExchangeRateSnapshotRepository,
  MANUAL_RATE_PROVIDER,
  SnapshotOrigin,
  SnapshotStatus,
} from '../../fx/exchange-rate-snapshot.repository';
import { OutboxService } from '../../outbox/outbox.service';
import { ExchangeRateOverriddenPayload, OutboxEventType } from '../../outbox/outbox.types';
import { ActionPreconditionFailedError } from '../admin.errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { RateOverrideMode, RateOverridePayload } from './action-payloads';
import { ActionExecutor, ExecutionContext } from './action-registry';

/** The only rejection an override may accept: the jump rule (Phase 6 decision 5). Anything else is broken data. */
export const OVERRIDABLE_REJECTION_PREFIX = 'RATE_JUMP:';

const refuse = (reason: string, message: string, details: Record<string, unknown> = {}) => new ActionPreconditionFailedError(reason, message, details);

/**
 * RATE_OVERRIDE (design §9.2, §16; Phase 10 plan §E.6). Neither mode calls a provider, so the budget and the
 * breaker are untouched; both write the database only (request handlers never write Redis) and announce the new
 * snapshot with `ExchangeRateOverridden.v1`, whose worker handler offers it to the cache.
 *
 * - ACCEPT_REJECTED_SNAPSHOT: the LATEST fetch, REJECTED only by the jump rule, not overridden yet → an ACCEPTED
 *   copy (same provider, publication times and rates of the active currencies; `origin OVERRIDE`, linked to the
 *   rejected fetch and the approval). It becomes the jump reference, so the halt ends: the next fetch is judged
 *   against it. Freshness is unchanged — an old publication is not made executable by being approved.
 * - MANUAL_RATE: every active currency, USD exactly 1, each within `FX_RATE_BOUNDS`; `provider = manual`,
 *   published now (the FX clock) and valid for the approved seconds with no grace — at most
 *   `MANUAL_RATE_MAXIMUM_VALIDITY_SECONDS`, or the shorter break-glass cap for a single actor. Never the
 *   provider's jump reference. Trades priced off it say `rate_provider = manual`.
 */
@Injectable()
export class RateOverrideExecutor implements ActionExecutor<ApprovalActionType.RATE_OVERRIDE> {
  readonly actionType = ApprovalActionType.RATE_OVERRIDE;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly snapshots: ExchangeRateSnapshotRepository,
    private readonly audit: AuditLogService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async validateRequest(payload: RateOverridePayload): Promise<void> {
    if (payload.mode === RateOverrideMode.ACCEPT_REJECTED_SNAPSHOT) await this.overridable(payload.snapshotId);
    else await this.manualRates(payload, this.config.admin.manualRateMaximumValiditySeconds);
  }

  async execute(payload: RateOverridePayload, context: ExecutionContext): Promise<string> {
    let snapshotId: string;
    let overriddenSnapshotId: string | undefined;
    if (payload.mode === RateOverrideMode.ACCEPT_REJECTED_SNAPSHOT) {
      const rejected = await this.overridable(payload.snapshotId);
      overriddenSnapshotId = rejected.id;
      snapshotId = await this.snapshots.insert({
        provider: rejected.provider,
        baseCurrency: 'USD',
        providerUpdatedAt: rejected.providerUpdatedAt,
        providerNextUpdateAt: rejected.providerNextUpdateAt,
        fetchedAt: rejected.fetchedAt,
        status: SnapshotStatus.ACCEPTED,
        rejectionReasons: [],
        providerCallId: undefined,
        rates: rejected.rates,
        origin: SnapshotOrigin.OVERRIDE,
        approvalId: context.approvalId,
        overridesSnapshotId: rejected.id,
      });
    } else {
      const maximum = context.isBreakGlass
        ? this.config.admin.breakGlassManualRateMaximumValiditySeconds
        : this.config.admin.manualRateMaximumValiditySeconds;
      const rates = await this.manualRates(payload, maximum);
      const now = this.clock.now();
      snapshotId = await this.snapshots.insert({
        provider: MANUAL_RATE_PROVIDER,
        baseCurrency: 'USD',
        providerUpdatedAt: now,
        providerNextUpdateAt: new Date(now.getTime() + payload.validForSeconds * 1000),
        fetchedAt: now,
        status: SnapshotStatus.ACCEPTED,
        rejectionReasons: [],
        providerCallId: undefined,
        rates,
        origin: SnapshotOrigin.MANUAL,
        approvalId: context.approvalId,
      });
    }
    await this.audit.record({
      actor: { type: 'OPERATOR', id: context.executedBy },
      action: AuditAction.EXCHANGE_RATE_OVERRIDDEN,
      subject: { type: AuditSubjectType.EXCHANGE_RATE_SNAPSHOT, id: snapshotId },
      after: {
        snapshotId,
        approvalId: context.approvalId,
        actionType: this.actionType,
        breakGlass: context.isBreakGlass,
        ...(overriddenSnapshotId ? { overriddenSnapshotId } : {}),
      },
      reason: context.reason,
    });
    const event: ExchangeRateOverriddenPayload = { snapshotId, approvalId: context.approvalId };
    await this.outbox.enqueue(OutboxEventType.EXCHANGE_RATE_OVERRIDDEN, snapshotId, event);
    return snapshotId;
  }

  private async overridable(snapshotId: string) {
    const evidence = await this.snapshots.findEvidence(snapshotId);
    if (!evidence) throw refuse('SNAPSHOT_NOT_FOUND', 'No such snapshot.', { snapshotId });
    if (evidence.status !== SnapshotStatus.REJECTED) throw refuse('SNAPSHOT_NOT_REJECTED', 'Only a rejected fetch can be accepted by override.', { snapshotId });
    if (evidence.provider !== this.config.fx.providerName) throw refuse('SNAPSHOT_NOT_OURS', 'The snapshot is not from the configured provider.', { snapshotId });
    if (evidence.overridden) throw refuse('SNAPSHOT_ALREADY_OVERRIDDEN', 'This fetch was already accepted by override.', { snapshotId });
    if (evidence.rejectionReasons.length === 0 || !evidence.rejectionReasons.every((reason) => reason.startsWith(OVERRIDABLE_REJECTION_PREFIX))) {
      throw refuse('SNAPSHOT_NOT_OVERRIDABLE', 'Only a fetch rejected by the jump rule alone can be overridden.', {
        snapshotId,
        rejectionReasons: evidence.rejectionReasons,
      });
    }
    if (!evidence.providerUpdatedAt || !evidence.providerNextUpdateAt) throw refuse('SNAPSHOT_NOT_OVERRIDABLE', 'The fetch has no publication times.', { snapshotId });
    const latest = await this.snapshots.latestFetch(evidence.provider);
    if (latest?.id !== evidence.id) {
      throw refuse('SNAPSHOT_SUPERSEDED', 'A newer fetch exists: override the latest one (or none — it may have been accepted).', {
        snapshotId,
        latestSnapshotId: latest?.id ?? null,
      });
    }
    const active = await this.activeCurrencies();
    const rates = new Map([...evidence.rates].filter(([currency]) => active.includes(currency)));
    for (const currency of active) {
      if (!rates.has(currency)) throw refuse('SNAPSHOT_NOT_OVERRIDABLE', `The fetch has no rate for ${currency}.`, { snapshotId });
    }
    return { ...evidence, providerUpdatedAt: evidence.providerUpdatedAt, providerNextUpdateAt: evidence.providerNextUpdateAt, rates };
  }

  private async manualRates(payload: Extract<RateOverridePayload, { mode: RateOverrideMode.MANUAL_RATE }>, maximumValiditySeconds: number): Promise<Map<string, Dec>> {
    if (payload.validForSeconds > maximumValiditySeconds) {
      throw refuse('MANUAL_RATE_VALIDITY_TOO_LONG', `A manual rate is valid for at most ${maximumValiditySeconds}s.`, {
        validForSeconds: payload.validForSeconds,
        maximumValiditySeconds,
      });
    }
    const active = await this.activeCurrencies();
    const given = Object.keys(payload.rates);
    const unknown = given.filter((currency) => !active.includes(currency));
    const missing = active.filter((currency) => !given.includes(currency));
    if (unknown.length > 0 || missing.length > 0) {
      throw refuse('MANUAL_RATE_INCOMPLETE', 'A manual rate names every active currency, and only those.', { unknown, missing });
    }
    const rates = new Map<string, Dec>();
    for (const currency of active) {
      const value = dec(payload.rates[currency] as string);
      if (currency === 'USD' && !value.eq(1)) throw refuse('MANUAL_RATE_OUT_OF_BOUNDS', 'USD is exactly 1 (the base).', { currency });
      const bounds = this.config.fx.rateBounds.get(currency);
      if (!value.gt(0) || (bounds && (value.lt(dec(bounds.minimum)) || value.gt(dec(bounds.maximum))))) {
        throw refuse('MANUAL_RATE_OUT_OF_BOUNDS', `${currency} is outside its configured bounds.`, { currency, rate: value.toFixed() });
      }
      rates.set(currency, value);
    }
    return rates;
  }

  private async activeCurrencies(): Promise<string[]> {
    const rows = (await this.unitOfWork.manager.query(`SELECT code FROM currencies WHERE is_active ORDER BY code`)) as { code: string }[];
    return rows.map((row) => row.code.trim());
  }
}
