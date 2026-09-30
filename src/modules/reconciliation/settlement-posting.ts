import { InvariantViolationError } from '../../common/errors';
import { Money } from '../../common/money';
import {
  EntryDirection,
  LedgerEntryDraft,
  PostingAuthorization,
  PostingRequest,
  TransactionType,
} from '../ledger/ledger.types';
import { ProviderSettlementBatch, ProviderSettlementLineType } from '../payments/payment-provider.port';
import { LineDecision, validateSettlementReport } from './settlement-matcher';

export const RECONCILIATION_INITIATED_BY = 'job:reconciliation';
export const SETTLEMENT_REASON_CODE = 'PSP_SETTLEMENT';

export function settlementReference(provider: string, batchId: string): string {
  return `settlement:${provider}:${batchId}`;
}

/**
 * One batch → one posting (Phase 9 plan §E; Phase 5 decision 1), in the batch's one currency:
 *
 * | Account | Dr/Cr | Amount |
 * |---|---|---|
 * | `BANK` | DEBIT (CREDIT if negative) | the PSP's net |
 * | `EXPENSE:PSP_FEES` | DEBIT | every line's fee (payment and chargeback fees: ours, never the user's) |
 * | `PSP_RECEIVABLE` | DEBIT | attributed chargeback deductions (discharging our REVERSAL's credit) |
 * | `CLEARING` | DEBIT | chargeback deductions we cannot attribute |
 * | `PSP_RECEIVABLE` | CREDIT | attributed payments, gross |
 * | `CLEARING` | CREDIT | payments we cannot attribute, gross |
 *
 * Debits = credits ⇔ `net = gross − fees − chargebacks`, which the report was checked to state.
 * Fees come from the report in minor units: nothing is rounded here. Zero amounts are left out
 * (an entry is strictly positive).
 */
export function buildSettlementPosting(
  provider: string,
  batch: ProviderSettlementBatch,
  decisions: readonly LineDecision[],
  activeCurrencies: ReadonlySet<string>,
): PostingRequest {
  const rejection = validateSettlementReport(batch, activeCurrencies);
  if (rejection !== null) {
    throw new InvariantViolationError('A settlement report that does not add up must never be posted.', {
      batchId: batch.batchId,
      rejection,
    });
  }
  if (decisions.length !== batch.lines.length) {
    throw new InvariantViolationError('Every settlement line needs exactly one decision.', { batchId: batch.batchId });
  }

  const currency = batch.currency;
  let attributedPayments = 0n;
  let clearingPayments = 0n;
  let attributedChargebacks = 0n;
  let clearingChargebacks = 0n;
  let fees = 0n;
  for (const decision of decisions) {
    const { line, attribution } = decision;
    fees += line.feeMinor;
    const attributed = attribution === 'ATTRIBUTED';
    if (line.type === ProviderSettlementLineType.PAYMENT) {
      if (attributed) attributedPayments += line.amountMinor;
      else clearingPayments += line.amountMinor;
    } else if (attributed) attributedChargebacks += line.amountMinor;
    else clearingChargebacks += line.amountMinor;
  }

  const entries: LedgerEntryDraft[] = [];
  const add = (systemAccount: string, direction: EntryDirection, amountMinor: bigint) => {
    if (amountMinor > 0n) entries.push({ account: { systemAccount }, direction, amount: Money.of(amountMinor, currency) });
  };
  if (batch.netMinor >= 0n) add('BANK', EntryDirection.DEBIT, batch.netMinor);
  else add('BANK', EntryDirection.CREDIT, -batch.netMinor);
  add('EXPENSE:PSP_FEES', EntryDirection.DEBIT, fees);
  add('PSP_RECEIVABLE', EntryDirection.DEBIT, attributedChargebacks);
  add('CLEARING', EntryDirection.DEBIT, clearingChargebacks);
  add('PSP_RECEIVABLE', EntryDirection.CREDIT, attributedPayments);
  add('CLEARING', EntryDirection.CREDIT, clearingPayments);

  const debits = entries.filter((entry) => entry.direction === EntryDirection.DEBIT).reduce((total, entry) => total + entry.amount.amountMinor, 0n);
  const credits = entries.filter((entry) => entry.direction === EntryDirection.CREDIT).reduce((total, entry) => total + entry.amount.amountMinor, 0n);
  if (debits !== credits || entries.length < 2) {
    throw new InvariantViolationError('A settlement posting must balance and move money.', {
      batchId: batch.batchId,
      debitsMinor: debits.toString(),
      creditsMinor: credits.toString(),
      entryCount: entries.length,
    });
  }

  return {
    transaction: {
      type: TransactionType.SETTLEMENT,
      authorization: PostingAuthorization.SYSTEM_DRIVEN,
      valueTime: batch.settledAt,
      settlementTime: batch.settledAt,
      initiatedBy: RECONCILIATION_INITIATED_BY,
      reference: settlementReference(provider, batch.batchId),
      reasonCode: SETTLEMENT_REASON_CODE,
      externalReference: batch.batchId,
      metadata: {
        provider,
        batchId: batch.batchId,
        lineCount: batch.lines.length,
        attributedLines: decisions.filter((decision) => decision.attribution === 'ATTRIBUTED').length,
        clearingLines: decisions.filter((decision) => decision.attribution === 'CLEARING').length,
      },
    },
    entries,
  };
}
