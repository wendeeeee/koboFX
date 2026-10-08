import { MOCK_BANK_CODES, MockTransferStatus } from './mock-paystack-transfers';

/** One bank account the dev mock's `/bank/resolve` knows. */
export interface MockSeedAccount {
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
}

export interface MockPaystackSeed {
  readonly accounts: readonly MockSeedAccount[];
  /** The Paystack balance transfers are paid from, in kobo. */
  readonly balanceMinor: bigint;
  /** The status every new transfer gets. */
  readonly transferStatus: MockTransferStatus;
  /** Paystack's transfer fee charged per transfer, in kobo. */
  readonly transferFeeMinor: bigint;
}

export const DEFAULT_MOCK_ACCOUNTS = '058:0123456789:ADA LOVELACE,044:0000000001:GRACE HOPPER,057:1234567890:ALAN TURING';
/** ₦1,000,000,000 in kobo: plenty for local testing. */
export const DEFAULT_MOCK_BALANCE_MINOR = '100000000000';
/** ₦10 in kobo. */
export const DEFAULT_MOCK_TRANSFER_FEE_MINOR = '1000';

const SEEDABLE_STATUSES: readonly MockTransferStatus[] = ['success', 'pending', 'failed', 'otp'];
const MINOR = /^(0|[1-9]\d{0,17})$/;

/**
 * The dev mock's starting state (`npm run start:mock-paystack:dev`), from the environment, so withdrawals work locally
 * end to end: bank accounts to resolve, a balance to pay transfers from, and what Paystack answers about each transfer.
 *
 * - `MOCK_PAYSTACK_ACCOUNTS` — `bankCode:accountNumber:NAME`, comma-separated (bank codes from the mock's bank list;
 *   ten-digit account numbers). Default: three accounts (`DEFAULT_MOCK_ACCOUNTS`).
 * - `MOCK_PAYSTACK_BALANCE` — kobo. Default ₦1,000,000,000.
 * - `MOCK_PAYSTACK_TRANSFER_STATUS` — `success` (default), `pending` (stays pending: to watch an "on its way"
 *   withdrawal), `failed` (the hold is released), `otp` (Paystack waiting for its transfer OTP: never completes).
 * - `MOCK_PAYSTACK_TRANSFER_FEE` — kobo per transfer (Paystack's fee, booked as our expense). Default ₦10.
 *
 * Anything malformed throws: the mock refuses to start rather than run with a state nobody asked for.
 */
export function parseMockPaystackSeed(env: Record<string, string | undefined>): MockPaystackSeed {
  const accounts = (env.MOCK_PAYSTACK_ACCOUNTS?.trim() || DEFAULT_MOCK_ACCOUNTS).split(',').map((entry, index) => {
    const parts = entry.trim().split(':');
    if (parts.length !== 3) throw new Error(`MOCK_PAYSTACK_ACCOUNTS entry ${index + 1} must be bankCode:accountNumber:NAME`);
    const [bankCode, accountNumber, accountName] = parts.map((part) => part.trim());
    if (!MOCK_BANK_CODES.includes(bankCode)) {
      throw new Error(`MOCK_PAYSTACK_ACCOUNTS entry ${index + 1}: bank code ${bankCode} is not one of ${MOCK_BANK_CODES.join(', ')}`);
    }
    if (!/^\d{10}$/.test(accountNumber)) throw new Error(`MOCK_PAYSTACK_ACCOUNTS entry ${index + 1}: the account number must be ten digits`);
    if (accountName.length < 1 || accountName.length > 100) throw new Error(`MOCK_PAYSTACK_ACCOUNTS entry ${index + 1}: the name must be 1–100 characters`);
    return { bankCode, accountNumber, accountName };
  });
  const balance = env.MOCK_PAYSTACK_BALANCE?.trim() || DEFAULT_MOCK_BALANCE_MINOR;
  if (!MINOR.test(balance)) throw new Error('MOCK_PAYSTACK_BALANCE must be a whole number of kobo');
  const fee = env.MOCK_PAYSTACK_TRANSFER_FEE?.trim() || DEFAULT_MOCK_TRANSFER_FEE_MINOR;
  if (!MINOR.test(fee)) throw new Error('MOCK_PAYSTACK_TRANSFER_FEE must be a whole number of kobo');
  const status = (env.MOCK_PAYSTACK_TRANSFER_STATUS?.trim() || 'success') as MockTransferStatus;
  if (!SEEDABLE_STATUSES.includes(status)) throw new Error(`MOCK_PAYSTACK_TRANSFER_STATUS must be one of ${SEEDABLE_STATUSES.join(', ')}`);
  return { accounts, balanceMinor: BigInt(balance), transferStatus: status, transferFeeMinor: BigInt(fee) };
}
