import { DEFAULT_MOCK_ACCOUNTS, parseMockPaystackSeed } from './dev-seed';

describe('dev mock Paystack seed', () => {
  it('defaults: three resolvable accounts, ₦1,000,000,000, transfers that succeed with a ₦10 fee', () => {
    const seed = parseMockPaystackSeed({});
    expect(seed.accounts).toHaveLength(DEFAULT_MOCK_ACCOUNTS.split(',').length);
    expect(seed.accounts[0]).toEqual({ bankCode: '058', accountNumber: '0123456789', accountName: 'ADA LOVELACE' });
    expect(seed).toMatchObject({ balanceMinor: 100_000_000_000n, transferStatus: 'success', transferFeeMinor: 1_000n });
  });

  it('reads every setting; amounts stay exact beyond 2^53', () => {
    const seed = parseMockPaystackSeed({
      MOCK_PAYSTACK_ACCOUNTS: ' 044:0000000001:GRACE HOPPER , 011:9999999999:Chinwe Okafor ',
      MOCK_PAYSTACK_BALANCE: '900719925474099300',
      MOCK_PAYSTACK_TRANSFER_STATUS: 'pending',
      MOCK_PAYSTACK_TRANSFER_FEE: '0',
    });
    expect(seed.accounts).toEqual([
      { bankCode: '044', accountNumber: '0000000001', accountName: 'GRACE HOPPER' },
      { bankCode: '011', accountNumber: '9999999999', accountName: 'Chinwe Okafor' },
    ]);
    expect(seed).toMatchObject({ balanceMinor: 900_719_925_474_099_300n, transferStatus: 'pending', transferFeeMinor: 0n });
  });

  it.each([
    [{ MOCK_PAYSTACK_ACCOUNTS: '058:0123456789' }, /bankCode:accountNumber:NAME/],
    [{ MOCK_PAYSTACK_ACCOUNTS: '999:0123456789:X' }, /bank code 999/],
    [{ MOCK_PAYSTACK_ACCOUNTS: '058:123:X' }, /ten digits/],
    [{ MOCK_PAYSTACK_ACCOUNTS: '058:0123456789: ' }, /1–100 characters/],
    [{ MOCK_PAYSTACK_BALANCE: '1.5' }, /MOCK_PAYSTACK_BALANCE/],
    [{ MOCK_PAYSTACK_BALANCE: '-10' }, /MOCK_PAYSTACK_BALANCE/],
    [{ MOCK_PAYSTACK_TRANSFER_FEE: '1e3' }, /MOCK_PAYSTACK_TRANSFER_FEE/],
    [{ MOCK_PAYSTACK_TRANSFER_STATUS: 'reversed' }, /MOCK_PAYSTACK_TRANSFER_STATUS/],
  ])('refuses %j (the mock does not start)', (env, message) => {
    expect(() => parseMockPaystackSeed(env)).toThrow(message);
  });
});
