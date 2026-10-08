import { ProviderPaymentStatus } from './payment-provider.port';
import { ProviderResponseInvalidError } from './payment.errors';
import { parsePayment, parsePaymentList, providerErrorCode } from './psp-responses';
import { REDACTED, redact } from './redaction';

const wire = {
  id: 'pay_1',
  reference: 'flow-1',
  status: 'captured',
  amount: '9007199254740993', // beyond Number.MAX_SAFE_INTEGER: must survive exactly
  currency: 'NGN',
  captured_at: '2026-09-28T10:00:00.000Z',
  decline_code: null,
  chargeback: null,
};

describe('PSP response parsing (design §7.2 point 1)', () => {
  it('reads the fields we use; amounts never pass through a JS number', () => {
    const payment = parsePayment(wire, 'get-payment');
    expect(payment).toMatchObject({ paymentId: 'pay_1', reference: 'flow-1', status: ProviderPaymentStatus.CAPTURED, declineCode: null, chargeback: null });
    expect(payment.amount.amountMinor).toBe(9007199254740993n);
    expect(payment.capturedAt?.toISOString()).toBe('2026-09-28T10:00:00.000Z');
  });

  it('ignores fields we do not use, however odd', () => {
    expect(() => parsePayment({ ...wire, card: { number: 42 }, livemode: 'maybe', metadata: null, fee: 1.5 }, 'x')).not.toThrow();
  });

  it('fails loudly on a malformed field we use', () => {
    const broken = [
      { ...wire, amount: 150000 },
      { ...wire, amount: '1.50' },
      { ...wire, amount: '-5' },
      { ...wire, status: 'settled_maybe' },
      { ...wire, currency: 'ngn' },
      { ...wire, id: undefined },
      { ...wire, captured_at: 'yesterday' },
      { ...wire, captured_at: null },
      { ...wire, status: 'charged_back', chargeback: { id: 'cb', amount: 5, created_at: '2026-09-28T10:00:00Z' } },
    ];
    for (const body of broken) expect(() => parsePayment(body, 'get-payment')).toThrow(ProviderResponseInvalidError);
    expect(() => parsePayment('not an object', 'get-payment')).toThrow(ProviderResponseInvalidError);
  });

  it('parses every status and a chargeback', () => {
    const statuses = ['authorized', 'capture_pending', 'captured', 'declined', 'expired', 'voided', 'capture_failed', 'charged_back'];
    expect(statuses.map((status) => parsePayment({ ...wire, status }, 'x').status)).toEqual(Object.values(ProviderPaymentStatus));
    const charged = parsePayment({ ...wire, status: 'charged_back', chargeback: { id: 'cb_1', amount: '100', created_at: '2026-10-01T00:00:00Z' } }, 'x');
    expect(charged.chargeback).toMatchObject({ chargebackId: 'cb_1' });
    expect(charged.chargeback?.amount.amountMinor).toBe(100n);
  });

  it('parses lists and error bodies', () => {
    expect(parsePaymentList({ data: [wire], has_more: false }, 'list')).toHaveLength(1);
    expect(() => parsePaymentList({ items: [] }, 'list')).toThrow(ProviderResponseInvalidError);
    expect(providerErrorCode({ error: { code: 'rate_limited' } })).toBe('rate_limited');
    expect(providerErrorCode({ error: 'string' })).toBeNull();
    expect(providerErrorCode({ id: 'pay' })).toBeUndefined();
    expect(providerErrorCode(null)).toBeUndefined();
  });
});

describe('redaction (design §7.2: before insert)', () => {
  it('replaces credentials, signatures, card and contact data at any depth', () => {
    expect(
      redact({
        amount: '100',
        payment_method_token: 'tok_live_x',
        nested: [{ card: { number: '4242424242424242', cvv: '123' }, Authorization: 'Bearer s', ok: 1 }],
        secretKey: 'sk',
        email: 'a@b.c',
        signature: 't=1,v1=ab',
      }),
    ).toEqual({
      amount: '100',
      payment_method_token: REDACTED,
      nested: [{ card: REDACTED, Authorization: REDACTED, ok: 1 }],
      secretKey: REDACTED,
      email: REDACTED,
      signature: REDACTED,
    });
    expect(redact('plain')).toBe('plain');
    expect(redact(null)).toBeNull();
  });
});
