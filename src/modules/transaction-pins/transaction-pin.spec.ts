import { randomBytes } from 'node:crypto';
import { transactionPinDigest, transactionPinWeakness } from './transaction-pin';

describe('transaction PIN rules', () => {
  it.each(['402815', '135790', '000123', '987650', '112233', '121212', '102938'])('accepts %s', (pin) => {
    expect(transactionPinWeakness(pin)).toBeNull();
  });

  it.each([
    ['000000', 'same digit'],
    ['999999', 'same digit'],
    ['123456', 'sequence'],
    ['345678', 'sequence'],
    ['654321', 'sequence'],
    ['876543', 'sequence'],
    ['12345', '6 digits'],
    ['1234567', '6 digits'],
    ['12a456', '6 digits'],
    ['١٢٣٤٥٦', '6 digits'], // non-ASCII digits are not digits here
    ['', '6 digits'],
  ])('refuses %s (%s)', (pin, reason) => {
    expect(transactionPinWeakness(pin)).toContain(reason === 'same digit' ? 'same digit' : reason === 'sequence' ? 'sequence' : '6 digits');
  });

  it('the digest depends on the pepper, the user and the PIN — and never contains the PIN', () => {
    const pepper = randomBytes(32);
    const user = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';
    const digest = transactionPinDigest(pepper, user, '402815');
    expect(digest).toBe(transactionPinDigest(pepper, user, '402815'));
    expect(digest).not.toBe(transactionPinDigest(randomBytes(32), user, '402815'));
    expect(digest).not.toBe(transactionPinDigest(pepper, '9b3c5d7e-2f40-4b6c-9d8e-0f1a2b3c4d5e', '402815'));
    expect(digest).not.toBe(transactionPinDigest(pepper, user, '402816'));
    expect(digest).not.toContain('402815');
  });
});
