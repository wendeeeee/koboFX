import * as crypto from 'node:crypto';
import fc from 'fast-check';
import {
  ONE_TIME_PASSWORD_DIGITS,
  generateOneTimePassword,
  hashOneTimePassword,
  oneTimePasswordMatches,
} from './one-time-password';


const nodeCrypto = require('node:crypto') as typeof crypto;
const PEPPER = crypto.randomBytes(32);
const CHALLENGE = '7d0f8f0e-0b1a-4c55-9f55-0d7c1d6f1a11';

describe('one-time passwords (design §7.1)', () => {
  it('are always exactly six decimal digits, leading zeros kept', () => {
    for (let index = 0; index < 5_000; index += 1) {
      expect(generateOneTimePassword()).toMatch(/^\d{6}$/);
    }
  });

  it('come from crypto.randomInt over [0, 10^6) — the CSPRNG, not Math.random', () => {
    const spy = jest.spyOn(nodeCrypto, 'randomInt');
    const mathRandom = jest.spyOn(Math, 'random');
    generateOneTimePassword();
    expect(spy).toHaveBeenCalledWith(0, 10 ** ONE_TIME_PASSWORD_DIGITS);
    expect(mathRandom).not.toHaveBeenCalled();
    spy.mockRestore();
    mathRandom.mockRestore();
  });

  it('pad small values: randomInt → 42 gives "000042"', () => {
    const spy = jest.spyOn(nodeCrypto, 'randomInt').mockImplementation((() => 42) as never);
    expect(generateOneTimePassword()).toBe('000042');
    spy.mockRestore();
  });

  it('are uniform: every digit position is ~uniform over 0-9 (chi-square, 60k samples)', () => {
    const samples = 60_000;
    const counts = Array.from({ length: 6 }, () => new Array<number>(10).fill(0));
    for (let index = 0; index < samples; index += 1) {
      [...generateOneTimePassword()].forEach((digit, position) => (counts[position][Number(digit)] += 1));
    }
    const expected = samples / 10;
    for (const position of counts) {
      const chiSquare = position.reduce((sum, observed) => sum + (observed - expected) ** 2 / expected, 0);
      expect(chiSquare).toBeLessThan(33.7);
    }
  });

  it('are stored as HMAC-SHA256 under the pepper, bound to the challenge id', () => {
    const hmac = hashOneTimePassword(PEPPER, CHALLENGE, '123456');
    expect(hmac).toEqual(crypto.createHmac('sha256', PEPPER).update(`${CHALLENGE}:123456`).digest());
    expect(hmac).toHaveLength(32);
    expect(hashOneTimePassword(crypto.randomBytes(32), CHALLENGE, '123456')).not.toEqual(hmac);
    expect(hashOneTimePassword(PEPPER, crypto.randomUUID(), '123456')).not.toEqual(hmac);
  });

  it('match only the right code, for the right challenge, under the right pepper', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999_999 }), fc.integer({ min: 0, max: 999_999 }), (code, guess) => {
        const actual = code.toString().padStart(6, '0');
        const candidate = guess.toString().padStart(6, '0');
        const stored = hashOneTimePassword(PEPPER, CHALLENGE, actual);
        expect(oneTimePasswordMatches(PEPPER, CHALLENGE, candidate, stored)).toBe(actual === candidate);
      }),
    );
    const stored = hashOneTimePassword(PEPPER, CHALLENGE, '000001');
    expect(oneTimePasswordMatches(PEPPER, crypto.randomUUID(), '000001', stored)).toBe(false);
  });

  it('compare with timingSafeEqual, and refuse malformed candidates before comparing', () => {
    const spy = jest.spyOn(nodeCrypto, 'timingSafeEqual');
    const stored = hashOneTimePassword(PEPPER, CHALLENGE, '123456');
    expect(oneTimePasswordMatches(PEPPER, CHALLENGE, '123456', stored)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    for (const malformed of ['12345', '1234567', '12345a', ' 123456', '', '１２３４５６']) {
      expect(oneTimePasswordMatches(PEPPER, CHALLENGE, malformed, stored)).toBe(false);
    }
    expect(oneTimePasswordMatches(PEPPER, CHALLENGE, '123456', stored.subarray(0, 16))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
