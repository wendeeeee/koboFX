import { ProviderCallRecord, ProviderCallRecorder } from '../../../../common/http/provider-call-recorder';
import {
  parseBalanceLedgerPage,
  parseBalances,
  parseBankPage,
  parsePaystackTransferJson,
  parseResolvedAccount,
  readTransferObservation,
} from './paystack-transfer-responses';
import { classifyTransferResponse, PaystackTransfersHttpClient } from './paystack-transfers-http-client';
import { PaystackTransfersAdapter } from './paystack-transfers.adapter';
import {
  DOCUMENTED_TRANSFER_STATUSES,
  PaystackTransferCallFailedError,
  PaystackTransferRefusal,
  TransferCallFailureKind,
  TransferStatusClassification,
} from './paystack-transfers.port';

const BIG_ID = '9007199254740993123';
const REFERENCE = 'withdrawal-3f2c4c3e-8d2b-4a51-9b6f-0e1d2c3b4a59';
const ACCOUNT = '0123456789';

/** A verify answer as documented (§B): numeric ids, nested recipient, nullable fee breakdown, `transferred_at: null`. */
function transferJson(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    amount: '300000',
    currency: '"NGN"',
    domain: '"test"',
    id: BIG_ID,
    integration: '463433',
    reference: `"${REFERENCE}"`,
    status: '"success"',
    transfer_code: '"TRF_1ptvuv321ahaa7q"',
    transferred_at: 'null',
    fee_charged: '1000',
    fees_breakdown: 'null',
    createdAt: '"2026-10-02T10:00:00.000Z"',
    updatedAt: '"2026-10-02T10:00:05.000Z"',
    recipient: `{"active":true,"currency":"NGN","domain":"test","id":9001520,"integration":463433,"name":"Ada Lovelace","recipient_code":"RCP_t0ya41mp35flk40","type":"nuban","is_deleted":false,"details":{"authorization_code":null,"account_number":"${ACCOUNT}","account_name":null,"bank_code":"058","bank_name":"Guaranty Trust Bank"}}`,
    ...overrides,
  };
  const body = Object.entries(fields)
    .filter(([, value]) => value !== 'OMIT')
    .map(([key, value]) => `"${key}":${value}`)
    .join(',');
  return `{"status":true,"message":"Transfer retrieved","data":{${body}}}`;
}

const read = (text: string) => readTransferObservation((parsePaystackTransferJson(text) as { data: unknown }).data);

describe('transfer observations (lossless, tolerant)', () => {
  it('keeps ids beyond 2^53 as text, money as exact bigint, null times and fees as null', () => {
    const observation = read(transferJson());
    expect(observation.classification).toBe(TransferStatusClassification.SUCCESS);
    expect(observation.transferId).toBe(BIG_ID);
    expect(observation.amountMinor).toBe(300_000n);
    expect(observation.transferredAt).toBeNull();
    expect(observation.feeChargedMinor).toBe(1_000n);
    expect(observation.recipient?.recipientCode).toBe('RCP_t0ya41mp35flk40');
    expect(observation.recipient?.details).toEqual({ bankCode: '058', bankName: 'Guaranty Trust Bank', accountNumber: ACCOUNT, accountName: null });
    expect(read(transferJson({ fee_charged: 'null' })).feeChargedMinor).toBeNull();
    expect(read(transferJson({ fee_charged: 'OMIT' })).feeChargedMinor).toBeNull();
    expect(read(transferJson({ amount: '9223372036854775807' })).amountMinor).toBe(9_223_372_036_854_775_807n);
  });

  it.each(Object.entries(DOCUMENTED_TRANSFER_STATUSES))('maps the documented status %s', (status, classification) => {
    expect(read(transferJson({ status: `"${status}"` })).classification).toBe(classification);
  });

  it.each([
    ['an unknown status string', { status: '"queued_for_review"' }, TransferStatusClassification.UNKNOWN],
    ['a null status', { status: 'null' }, TransferStatusClassification.MALFORMED],
    ['a fractional amount', { amount: '300000.5' }, TransferStatusClassification.MALFORMED],
    ['an exponent amount', { amount: '3e5' }, TransferStatusClassification.MALFORMED],
    ['a string amount', { amount: '"300000"' }, TransferStatusClassification.MALFORMED],
    ['an amount beyond BIGINT', { amount: '9223372036854775808' }, TransferStatusClassification.MALFORMED],
    ['a negative amount', { amount: '-1' }, TransferStatusClassification.MALFORMED],
    ['a missing reference', { reference: 'OMIT' }, TransferStatusClassification.MALFORMED],
    ['a lowercase currency', { currency: '"ngn"' }, TransferStatusClassification.MALFORMED],
    ['a malformed fee', { fee_charged: '10.5' }, TransferStatusClassification.MALFORMED],
    ['a recipient without a code', { recipient: '{"id":1,"type":"nuban"}' }, TransferStatusClassification.MALFORMED],
  ])('reads %s as %s — never as a failure', (_label, overrides, classification) => {
    const observation = read(transferJson(overrides));
    expect(observation.classification).toBe(classification);
    if (classification === TransferStatusClassification.MALFORMED) expect(observation.problems.length).toBeGreaterThan(0);
  });

  it('an initiate answer names the recipient by id; data that is not an object is MALFORMED', () => {
    const observation = read(transferJson({ recipient: '9001520', status: '"otp"' }));
    expect(observation.classification).toBe(TransferStatusClassification.OTP);
    expect(observation.recipientId).toBe('9001520');
    expect(observation.recipient).toBeNull();
    expect(readTransferObservation('nope').classification).toBe(TransferStatusClassification.MALFORMED);
  });
});

describe('other transfer-side readers', () => {
  it('keeps leading zeroes in account numbers and bank codes; a null account name stays null', () => {
    const resolved = parseResolvedAccount(parsePaystackTransferJson(`{"status":true,"data":{"account_number":"0001234567","account_name":null,"bank_id":9}}`), 'bank.resolve');
    expect(resolved).toEqual({ accountNumber: '0001234567', accountName: null, bankId: '9' });
    const banks = parseBankPage(
      parsePaystackTransferJson('{"status":true,"data":[{"name":"Access Bank","code":"044","active":true,"is_deleted":false,"currency":"NGN","type":"nuban","country":"Nigeria"}],"meta":{"next":"YmFuazoy","previous":null,"perPage":100}}'),
      'bank.list',
    );
    expect(banks.items[0].code).toBe('044');
    expect(banks.nextCursor).toBe('YmFuazoy');
  });

  it('balances and ledger differences are signed exact integers; malformed rows are refused', () => {
    expect(parseBalances(parsePaystackTransferJson('{"status":true,"data":[{"currency":"NGN","balance":-9007199254740993}]}'), 'balance.fetch')).toEqual([
      { currency: 'NGN', balanceMinor: -9_007_199_254_740_993n },
    ]);
    const ledger = parseBalanceLedgerPage(
      parsePaystackTransferJson(
        `{"status":true,"data":[{"id":${BIG_ID},"currency":"NGN","difference":-301000,"balance":699000,"model_responsible":"Transfer","model_row":29224327,"domain":"test","integration":1,"createdAt":"2026-10-02T10:00:00.000Z"}],"meta":{"page":1,"pageCount":1}}`,
      ),
      'balance.ledger',
    );
    expect(ledger.items[0]).toMatchObject({ rowId: BIG_ID, differenceMinor: -301_000n, balanceMinor: 699_000n, modelRow: '29224327' });
    expect(ledger.nextCursor).toBeNull();
    expect(() => parseBalances(parsePaystackTransferJson('{"status":true,"data":[{"currency":"NGN","balance":1.5}]}'), 'balance.fetch')).toThrow();
  });
});

describe('classifyTransferResponse', () => {
  it.each([
    [500, '{"status":false}', 'TRANSIENT', undefined],
    [429, '{"status":false}', 'TRANSIENT', undefined],
    [200, '{"status":false,"message":"oops"}', 'TRANSIENT', undefined],
    [200, '<html>', 'INVALID', undefined],
    [200, '{"status":true,"data":{"amount":0300000}}', 'INVALID', undefined], // a leading zero is not JSON
    [401, '{"status":false,"message":"Invalid key","code":"invalid_Key"}', 'DEFINITIVE', PaystackTransferRefusal.CONFIGURATION],
    [400, '{"status":false,"message":"You cannot initiate third party payouts as a starter business"}', 'DEFINITIVE', PaystackTransferRefusal.CONFIGURATION],
    [400, '{"status":false,"message":"Duplicate Transfer Reference"}', 'DEFINITIVE', PaystackTransferRefusal.DUPLICATE_REFERENCE],
    [400, '{"status":false,"message":"Your balance is not enough to fulfil this request"}', 'DEFINITIVE', PaystackTransferRefusal.INSUFFICIENT_BALANCE],
    [422, '{"status":false,"message":"Could not resolve account name. Check parameters or try again."}', 'DEFINITIVE', PaystackTransferRefusal.ACCOUNT_NOT_RESOLVED],
    [404, '{"status":false,"message":"Transfer not found"}', 'DEFINITIVE', PaystackTransferRefusal.NOT_FOUND],
    [400, '{"status":false,"message":"Something else"}', 'DEFINITIVE', PaystackTransferRefusal.REJECTED],
  ])('%s %s → %s %s', (status, body, outcome, refusal) => {
    const result = classifyTransferResponse(status, body);
    expect(result.outcome).toBe(outcome);
    if (refusal) expect((result as { providerErrorCode: string }).providerErrorCode).toBe(refusal);
  });
});

describe('PaystackTransfersAdapter over a scripted transport', () => {
  class CapturingRecorder {
    readonly calls: ProviderCallRecord[] = [];
    async recordQuietly(call: ProviderCallRecord): Promise<string> {
      this.calls.push(call);
      return String(this.calls.length);
    }
  }
  const setup = (replies: Array<{ status: number; body: string } | { throws: unknown }>) => {
    const recorder = new CapturingRecorder();
    const sent: { method: string; url: string; body: string | undefined }[] = [];
    const client = new PaystackTransfersHttpClient(
      {
        provider: 'paystack',
        baseUrl: 'http://paystack.test',
        secretKey: 'sk_test_abcdefgh12345678',
        timeoutMilliseconds: 1000,
        writeTimeoutMilliseconds: 1000,
        readRetries: 2,
        sleep: async () => undefined,
        fetch: (async (url: URL, init: RequestInit) => {
          sent.push({ method: String(init.method), url: String(url), body: init.body as string | undefined });
          const reply = replies.shift();
          if (!reply) throw new Error('no reply scripted');
          if ('throws' in reply) throw reply.throws;
          return new Response(reply.body, { status: reply.status });
        }) as unknown as typeof fetch,
      },
      recorder as unknown as ProviderCallRecorder,
    );
    return { adapter: new PaystackTransfersAdapter(client), recorder, sent };
  };

  it('initiates ONCE with the amount as an exact JSON integer; the exchange keeps the exact bytes', async () => {
    const answer = transferJson({ status: '"pending"', recipient: '9001520', amount: '9007199254740993' });
    const { adapter, sent, recorder } = setup([{ status: 200, body: answer }]);
    const result = await adapter.initiateTransfer(
      { amountMinor: 9_007_199_254_740_993n, currency: 'NGN', recipientCode: 'RCP_t0ya41mp35flk40', reference: REFERENCE, reason: 'KoboFX withdrawal' },
      { flowId: '3f2c4c3e-8d2b-4a51-9b6f-0e1d2c3b4a59' },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe(
      `{"source":"balance","amount":9007199254740993,"currency":"NGN","recipient":"RCP_t0ya41mp35flk40","reference":"${REFERENCE}","reason":"KoboFX withdrawal"}`,
    );
    expect(result.value.classification).toBe(TransferStatusClassification.PENDING);
    expect(result.value.amountMinor).toBe(9_007_199_254_740_993n);
    expect(result.exchange.rawResponse?.toString('utf8')).toBe(answer);
    expect(result.exchange.requestSha256).toHaveLength(32);
    expect(recorder.calls[0].requestBody).toEqual({ source: 'balance', amount: '9007199254740993', currency: 'NGN', recipient: '[REDACTED]', reference: REFERENCE });
  });

  it('a lost initiate answer is NOT retried: the write is sent once and fails TRANSIENT with no bytes', async () => {
    const { adapter, sent } = setup([{ throws: Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }, { status: 200, body: transferJson() }]);
    const failure = await adapter
      .initiateTransfer({ amountMinor: 1n, currency: 'NGN', recipientCode: 'RCP_x1', reference: REFERENCE, reason: 'x' }, {})
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PaystackTransferCallFailedError);
    expect((failure as PaystackTransferCallFailedError).kind).toBe(TransferCallFailureKind.TRANSIENT);
    expect((failure as PaystackTransferCallFailedError).exchange.rawResponse).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('verify retries reads, reports not-found as a result (not an error), and keeps refusals’ bytes', async () => {
    const { adapter, sent } = setup([{ status: 503, body: '{"status":false}' }, { status: 404, body: '{"status":false,"message":"Transfer not found"}' }]);
    const result = await adapter.verifyTransfer(REFERENCE, {});
    expect(result.found).toBe(false);
    expect(result.exchange.rawResponse?.toString('utf8')).toContain('Transfer not found');
    expect(sent).toHaveLength(2);

    const refused = setup([{ status: 401, body: '{"status":false,"message":"Invalid key"}' }]);
    const error = (await refused.adapter.verifyTransfer(REFERENCE, {}).catch((caught: unknown) => caught)) as PaystackTransferCallFailedError;
    expect(error.kind).toBe(TransferCallFailureKind.CONFIGURATION);
    expect(error.exchange.httpStatus).toBe(401);
  });

  it('a malformed transfer is still a value (MALFORMED, for review); an unreadable envelope is INVALID with its bytes', async () => {
    const { adapter } = setup([{ status: 200, body: transferJson({ amount: '1.5' }) }]);
    const result = await adapter.verifyTransfer(REFERENCE, {});
    expect(result.found && result.observation.classification).toBe(TransferStatusClassification.MALFORMED);

    const unreadable = setup([{ status: 200, body: '{"status":true,"data":[]}' }]);
    const error = (await unreadable.adapter.resolveAccount(ACCOUNT, '058', {}).catch((caught: unknown) => caught)) as PaystackTransferCallFailedError;
    expect(error.kind).toBe(TransferCallFailureKind.INVALID);
    expect(error.exchange.rawResponse?.toString('utf8')).toBe('{"status":true,"data":[]}');
  });

  it('resolve never records the account number — not in the path, not from an echoing error page', async () => {
    const { adapter, recorder, sent } = setup([
      { status: 502, body: `<html>upstream failed for account ${ACCOUNT}</html>` },
      { status: 200, body: `{"status":true,"data":{"account_number":"${ACCOUNT}","account_name":"ADA LOVELACE","bank_id":9}}` },
    ]);
    const result = await adapter.resolveAccount(ACCOUNT, '058', {});
    expect(result.value.accountName).toBe('ADA LOVELACE');
    expect(sent[0].url).toContain(`account_number=${ACCOUNT}`);
    expect(recorder.calls.map((call) => call.requestPath)).toEqual([
      '/bank/resolve?account_number=[REDACTED]&bank_code=058',
      '/bank/resolve?account_number=[REDACTED]&bank_code=058',
    ]);
    const recorded = JSON.stringify(recorder.calls);
    expect(recorded).not.toContain(ACCOUNT);
    expect(recorded).not.toContain('LOVELACE');
  });

  it('create recipient sends the account once and records neither it nor the name', async () => {
    const created = `{"status":true,"message":"Transfer recipient created successfully","data":{"active":true,"currency":"NGN","domain":"test","id":6788170,"integration":428626,"name":"Ada Lovelace","recipient_code":"RCP_t0ya41mp35flk40","type":"nuban","is_deleted":false,"details":{"authorization_code":null,"account_number":"${ACCOUNT}","account_name":null,"bank_code":"058","bank_name":"Guaranty Trust Bank"}}}`;
    const { adapter, recorder, sent } = setup([{ status: 201, body: created }]);
    const result = await adapter.createRecipient({ name: 'Ada Lovelace', accountNumber: ACCOUNT, bankCode: '058', currency: 'NGN' }, {});
    expect(result.value).toMatchObject({ recipientId: '6788170', recipientCode: 'RCP_t0ya41mp35flk40', details: { accountNumber: ACCOUNT } });
    expect(sent).toHaveLength(1);
    const recorded = JSON.stringify(recorder.calls);
    expect(recorded).not.toContain(ACCOUNT);
    expect(recorded).not.toContain('Lovelace');
  });

  it('refuses malformed inputs before anything is sent', async () => {
    const { adapter, sent } = setup([]);
    await expect(adapter.resolveAccount('12ab', '058', {})).rejects.toThrow(/digit account number/);
    await expect(adapter.verifyTransfer('UPPER-CASE-REFERENCE-123', {})).rejects.toThrow(/lowercase/);
    await expect(
      adapter.initiateTransfer({ amountMinor: 0n, currency: 'NGN', recipientCode: 'RCP_x', reference: REFERENCE, reason: 'x' }, {}),
    ).rejects.toThrow(/positive/);
    expect(sent).toHaveLength(0);
  });
});
