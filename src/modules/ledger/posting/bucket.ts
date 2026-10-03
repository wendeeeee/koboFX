import { createHash } from 'node:crypto';
import { InvariantViolationError } from '../../../common/errors';

/**
 * each internal account exists as `bucketCount` rows,
 * and a posting picks one by `hash(transactionId) % bucketCount`.
 */
export function bucketForTransaction(transactionId: string, bucketCount: number): number {
  if (!Number.isInteger(bucketCount) || bucketCount < 1) {
    throw new InvariantViolationError(`Bucket count must be a positive integer, got ${bucketCount}.`);
  }
  const digest = createHash('sha256').update(transactionId.toLowerCase(), 'utf8').digest();
  return digest.readUInt32BE(0) % bucketCount;
}

export function systemAccountCode(systemAccount: string, currency: string): string {
  return `${systemAccount}:${currency}`;
}

export function userAccountCode(walletId: string, currency: string): string {
  return `USER:${walletId}:${currency}`;
}
