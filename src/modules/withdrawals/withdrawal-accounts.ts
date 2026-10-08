import { EntityManager } from 'typeorm';
import { AccountNotFoundError } from '../ledger/ledger.errors';
import { bucketForTransaction, systemAccountCode } from '../ledger/posting/bucket';

export const PAYOUT_ACCOUNT_TEMPLATES = {
  payoutBalance: 'PAYSTACK_PAYOUT_BALANCE',
  payoutInTransit: 'PAYSTACK_PAYOUT_IN_TRANSIT',
  transferFees: 'EXPENSE:PAYSTACK_TRANSFER_FEES',
} as const;

export interface PayoutAccounts {
  readonly payoutBalanceId: string;
  readonly payoutInTransitId: string;
  readonly transferFeesId: string;
}

export function withdrawalInternalBucket(flowId: string, bucketCount: number): number {
  return bucketForTransaction(flowId, bucketCount);
}

export async function resolvePayoutAccounts(manager: EntityManager, currency: string, bucket: number): Promise<PayoutAccounts> {
  const codes = Object.values(PAYOUT_ACCOUNT_TEMPLATES).map((template) => systemAccountCode(template, currency));
  const rows = (await manager.query(
    `SELECT id, code FROM accounts
      WHERE code = ANY($1::text[]) AND bucket = $2 AND wallet_id IS NULL AND NOT authorizes_balance`,
    [codes, bucket],
  )) as { id: string; code: string }[];
  const byCode = new Map(rows.map((row) => [row.code, row.id]));
  const idOf = (template: string) => {
    const id = byCode.get(systemAccountCode(template, currency));
    if (!id) {
      throw new AccountNotFoundError('A payout account is not provisioned for this currency and bucket.', {
        account: template,
        currency,
        bucket,
      });
    }
    return id;
  };
  return {
    payoutBalanceId: idOf(PAYOUT_ACCOUNT_TEMPLATES.payoutBalance),
    payoutInTransitId: idOf(PAYOUT_ACCOUNT_TEMPLATES.payoutInTransit),
    transferFeesId: idOf(PAYOUT_ACCOUNT_TEMPLATES.transferFees),
  };
}
