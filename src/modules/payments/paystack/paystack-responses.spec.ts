import { parse } from 'lossless-json';
import { REDACTED, redactJsonTextLosslessly } from '../../../common/http/redaction';
import { ProviderResponseInvalidError } from '../payment.errors';
import { PAYSTACK_EXTRA_REDACTED_KEYS, PaystackRefusal, classifyPaystackResponse } from './paystack-http-client';
import {
  minorUnitsFromJsonNumber,
  parseCheckout,
  parseDisputePage,
  parsePaystackJson,
  parseTransaction,
  parseTransactionPage,
} from './paystack-responses';
import { PAYSTACK_STATUS_MEANING, PAYSTACK_TRANSACTION_STATUSES, PaystackStatusMeaning, PaystackTransactionStatus } from './paystack-status';

const verifyBody = (data: string) => parsePaystackJson(`{"status":true,"message":"Verification successful","data":${data}}`);
const transaction = (overrides: Record<string, string> = {}) => {
  const fields: Record<string, string> = {
    id: '2009945086',
    status: '"success"',
    reference: '"rd0bz6z2wu"',
    amount: '20000',
    currency: '"NGN"',
    paid_at: '"2022-08-09T14:21:32.000Z"',
    created_at: '"2022-08-09T14:20:57.000Z"',
    gateway_response: '"Successful"',
    requested_amount: '20000',
    customer: '{"email":"hello@example.com"}',
    ...overrides,
  };
  return `{${Object.entries(fields).map(([key, value]) => `"${key}":${value}`).join(',')}}`;
};

describe('Paystack lossless amounts (PAYSTACK_PLAN.md A1)', () => {
  it('only a plain non-negative integer JSON number is accepted, exactly', () => {
    expect(minorUnitsFromJsonNumber(parse('20000'))).toBe(20000n);
    expect(minorUnitsFromJsonNumber(parse('0'))).toBe(0n);
    expect(minorUnitsFromJsonNumber(parse('999999999999999999'))).toBe(999999999999999999n);
    for (const refused of ['19.99', '1998.9999999999998', '2e4', '2E4', '-100', '1.0', '1000000000000000000', '"20000"', 'null', '[]']) {
      expect(minorUnitsFromJsonNumber(parse(refused))).toBeUndefined();
    }
  });

  it('a verified amount never passes through a float (9007199254740993 stays odd)', () => {
    const parsed = parseTransaction(verifyBody(transaction({ amount: '9007199254740993' })), 'verify');
    expect(parsed.amount.amountMinor).toBe(9007199254740993n);
  });

  it('a decimal, an exponent, a huge value or a string amount fails the response, loudly', () => {
    for (const amount of ['200.5', '2e4', '12345678901234567890', '"20000"', '-1']) {
      expect(() => parseTransaction(verifyBody(transaction({ amount })), 'verify')).toThrow(ProviderResponseInvalidError);
    }
  });
});

describe('Paystack transactions', () => {
  it('reads only the fields we use; the id is kept as decimal text', () => {
    expect(parseTransaction(verifyBody(transaction()), 'verify')).toEqual({
      transactionId: '2009945086',
      reference: 'rd0bz6z2wu',
      status: PaystackTransactionStatus.SUCCESS,
      amount: expect.objectContaining({ amountMinor: 20000n, currency: 'NGN' }),
      paidAt: new Date('2022-08-09T14:21:32.000Z'),
      createdAt: new Date('2022-08-09T14:20:57.000Z'),
      gatewayResponse: 'Successful',
    });
  });

  it('a success without paid_at, a lower-case currency, a status:false body are refused', () => {
    expect(() => parseTransaction(verifyBody(transaction({ paid_at: 'null' })), 'verify')).toThrow(/paid_at/);
    expect(() => parseTransaction(verifyBody(transaction({ currency: '"ngn"' })), 'verify')).toThrow(ProviderResponseInvalidError);
    expect(() => parseTransaction(parsePaystackJson('{"status":false,"message":"x","data":null}'), 'verify')).toThrow(/status:false/);
  });

  it('a list carries its next page; the last page has none; no meta is refused', () => {
    const page = (pageNumber: number, pageCount: number) =>
      parsePaystackJson(`{"status":true,"data":[${transaction()}],"meta":{"total":3,"perPage":1,"page":${pageNumber},"pageCount":${pageCount}}}`);
    expect(parseTransactionPage(page(1, 3), 'list').nextCursor).toBe('2');
    expect(parseTransactionPage(page(3, 3), 'list').nextCursor).toBeNull();
    expect(() => parseTransactionPage(parsePaystackJson(`{"status":true,"data":[]}`), 'list')).toThrow(/meta/);
  });

  it('a checkout needs an http(s) authorization_url and an access code', () => {
    const checkout = parseCheckout(
      parsePaystackJson('{"status":true,"data":{"authorization_url":"https://checkout.paystack.com/0peioxfhpn","access_code":"0peioxfhpn","reference":"r"}}'),
      'initialize',
    );
    expect(checkout).toEqual({ authorizationUrl: 'https://checkout.paystack.com/0peioxfhpn', accessCode: '0peioxfhpn', reference: 'r' });
    expect(() =>
      parseCheckout(parsePaystackJson('{"status":true,"data":{"authorization_url":"javascript:alert(1)","access_code":"a","reference":"r"}}'), 'initialize'),
    ).toThrow(ProviderResponseInvalidError);
  });

  it('disputes: refund amount in subunits, the disputed transaction named', () => {
    const page = parseDisputePage(
      parsePaystackJson(
        '{"status":true,"data":[{"id":5,"status":"resolved","resolution":"merchant-accepted","refund_amount":20000,"currency":"NGN",' +
          '"createdAt":"2026-09-01T10:00:00.000Z","resolvedAt":"2026-09-03T10:00:00.000Z","transaction":{"id":2009945086,"reference":"r"}}],' +
          '"meta":{"page":1,"pageCount":1}}',
      ),
      'list-disputes',
    );
    expect(page.items[0]).toMatchObject({ disputeId: '5', transactionId: '2009945086', transactionReference: 'r', resolution: 'merchant-accepted' });
    expect(page.items[0].refundAmount?.amountMinor).toBe(20000n);
  });
});

describe('Paystack status mapping (PAYSTACK_PLAN.md A3–A5)', () => {
  it('every known status has an explicit meaning; only success is PAID', () => {
    expect(PAYSTACK_TRANSACTION_STATUSES).toHaveLength(8);
    expect(PAYSTACK_STATUS_MEANING).toEqual({
      success: PaystackStatusMeaning.PAID,
      abandoned: PaystackStatusMeaning.UNPAID,
      failed: PaystackStatusMeaning.UNPAID,
      ongoing: PaystackStatusMeaning.IN_FLIGHT,
      pending: PaystackStatusMeaning.IN_FLIGHT,
      processing: PaystackStatusMeaning.IN_FLIGHT,
      queued: PaystackStatusMeaning.IN_FLIGHT,
      reversed: PaystackStatusMeaning.REVERSED,
    });
    for (const status of PAYSTACK_TRANSACTION_STATUSES) {
      expect(parseTransaction(verifyBody(transaction({ status: `"${status}"` })), 'verify').status).toBe(status);
    }
  });

  it('an unknown status fails loudly', () => {
    expect(() => parseTransaction(verifyBody(transaction({ status: '"settled"' })), 'verify')).toThrow(/not one we know/);
  });
});

describe('Paystack response classification (PAYSTACK_PLAN.md A2, A17)', () => {
  it.each([
    [200, '{"status":true,"data":{}}', 'OK'],
    [200, '{"status":false,"message":"x"}', 'TRANSIENT'],
    [200, 'not json', 'INVALID'],
    [500, '{"status":false}', 'TRANSIENT'],
    [503, '', 'TRANSIENT'],
    [429, '{"status":false}', 'TRANSIENT'],
    [401, '{"status":false,"message":"Invalid key","code":"invalid_Key"}', 'DEFINITIVE'],
    [400, '{"status":false,"message":"Transaction reference not found"}', 'DEFINITIVE'],
  ])('%i %s → %s', (status, text, outcome) => {
    expect(classifyPaystackResponse(status, text).outcome).toBe(outcome);
  });

  it('names the two refusals the adapter acts on, by Paystack\'s message', () => {
    expect(classifyPaystackResponse(400, '{"status":false,"message":"Transaction reference not found"}')).toMatchObject({
      providerErrorCode: PaystackRefusal.REFERENCE_NOT_FOUND,
    });
    expect(classifyPaystackResponse(404, '{"status":false,"message":"Not found"}')).toMatchObject({ providerErrorCode: PaystackRefusal.REFERENCE_NOT_FOUND });
    expect(classifyPaystackResponse(400, '{"status":false,"message":"Duplicate Transaction Reference"}')).toMatchObject({
      providerErrorCode: PaystackRefusal.DUPLICATE_REFERENCE,
    });
    expect(classifyPaystackResponse(401, '{"status":false,"message":"Invalid key","code":"invalid_Key"}')).toMatchObject({
      providerErrorCode: 'invalid_Key',
    });
  });
});

describe('lossless redaction of recorded bodies', () => {
  it('keeps every digit and redacts the customer, the authorization and the email', () => {
    const text = redactJsonTextLosslessly(
      `{"status":true,"data":${transaction({ amount: '9007199254740993', authorization: '{"last4":"4081","bin":"408408"}', ip_address: '"10.0.0.1"' })}}`,
      PAYSTACK_EXTRA_REDACTED_KEYS,
    ) as string;
    expect(text).toContain('"amount":9007199254740993');
    expect(text).toContain(`"customer":"${REDACTED}"`);
    expect(text).toContain(`"authorization":"${REDACTED}"`);
    expect(text).toContain(`"ip_address":"${REDACTED}"`);
    expect(text).not.toContain('hello@example.com');
    expect(text).not.toContain('408408');
    expect(redactJsonTextLosslessly('not json', undefined)).toBeUndefined();
  });
});
