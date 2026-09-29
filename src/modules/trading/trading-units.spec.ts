import { ErrorCode } from '../../common/errors';
import { dec } from '../../common/money';
import { QuoteAmountMode } from '../fx/pricing';
import { conversionPostedOf } from '../notifications/outbox-handlers';
import { OutboxEventType } from '../outbox/outbox.types';
import { CONVERSION_STATES, ConversionState, assertConversionTransition, canTransitionConversion } from './conversion-transitions';
import { conversionView } from './conversion.view';
import { TradingMetrics } from './trading-metrics';

const TRANSACTION = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const FLOW = '00000000-0000-4000-8000-000000000003';
const QUOTE = '00000000-0000-4000-8000-000000000004';

describe('conversion transitions', () => {
  it('INITIATED → POSTED only', () => {
    const allowed = CONVERSION_STATES.flatMap((from) => CONVERSION_STATES.filter((to) => canTransitionConversion(from, to)).map((to) => `${from}→${to}`));
    expect(allowed).toEqual(['INITIATED→POSTED']);
    expect(() => assertConversionTransition(ConversionState.POSTED, ConversionState.INITIATED)).toThrow(/cannot move from POSTED/);
  });
});

describe('conversion view', () => {
  it('amounts as minor-unit strings, rates as 12-digit display strings, times as ISO', () => {
    const view = conversionView({
      transactionId: TRANSACTION,
      reference: `conversion:${FLOW}`,
      quoteId: null,
      amountMode: QuoteAmountMode.SOURCE,
      source: { code: 'NGN', minorUnit: 2 },
      target: { code: 'USD', minorUnit: 2 },
      sourceAmountMinor: 100_000_000n,
      targetAmountMinor: 65_011n,
      rateDisplay: '0.00065011',
      clientRate: dec('0.0006501143422684089513230970271153218'),
      midRate: dec('0.0006533812479581836001306762495916367'),
      spreadBasisPoints: 50,
      rateProvider: 'exchange-rate-api',
      rateProviderUpdatedAt: new Date('2026-09-29T00:00:01Z'),
      rateFetchedAt: new Date('2026-09-29T00:01:00Z'),
      rateSnapshotId: FLOW,
      valueTime: new Date('2026-09-29T00:02:00Z'),
      bookingTime: new Date('2026-09-29T00:02:00Z'),
    });
    expect(view).toEqual({
      transactionId: TRANSACTION,
      reference: `conversion:${FLOW}`,
      type: 'CONVERSION',
      status: 'POSTED',
      quoteId: null,
      amountMode: 'SOURCE',
      debited: { currency: 'NGN', minorUnit: 2, amount: '100000000' },
      credited: { currency: 'USD', minorUnit: 2, amount: '65011' },
      rateDisplay: '0.00065011',
      clientRate: '0.000650114342268',
      midRate: '0.000653381247958',
      spreadBasisPoints: 50,
      rate: { provider: 'exchange-rate-api', asOf: '2026-09-29T00:00:01.000Z', fetchedAt: '2026-09-29T00:01:00.000Z', snapshotId: FLOW },
      valueTime: '2026-09-29T00:02:00.000Z',
      bookingTime: '2026-09-29T00:02:00.000Z',
    });
  });
});

describe('trading metrics', () => {
  it('counts conversions_total{from,to,outcome}', () => {
    const metrics = new TradingMetrics();
    metrics.recordConversion('NGN', 'USD', 'POSTED');
    metrics.recordConversion('NGN', 'USD', 'POSTED');
    metrics.recordConversion('NGN', 'USD', ErrorCode.INSUFFICIENT_FUNDS);
    expect(metrics.conversionsTotal()).toEqual([
      { from: 'NGN', to: 'USD', outcome: 'POSTED', count: 2 },
      { from: 'NGN', to: 'USD', outcome: 'INSUFFICIENT_FUNDS', count: 1 },
    ]);
  });
});

describe('ConversionPosted.v1 payload', () => {
  const event = (payload: unknown, aggregateId = TRANSACTION) => ({
    id: 'event-1',
    eventType: OutboxEventType.CONVERSION_POSTED,
    aggregateId,
    payload,
    attempts: 1,
  });

  it('accepts ids only, with the transaction as aggregate and a nullable quote', () => {
    const payload = { transactionId: TRANSACTION, userId: USER, flowId: FLOW, quoteId: null };
    expect(conversionPostedOf(event(payload))).toEqual(payload);
    expect(conversionPostedOf(event({ ...payload, quoteId: QUOTE }))).toEqual({ ...payload, quoteId: QUOTE });
  });

  it.each([
    ['a missing field', { transactionId: TRANSACTION, userId: USER, quoteId: null }],
    ['an aggregate that is not the transaction', { transactionId: USER, userId: USER, flowId: FLOW, quoteId: null }],
    ['a malformed quote id', { transactionId: TRANSACTION, userId: USER, flowId: FLOW, quoteId: 'nope' }],
    ['no payload', null],
  ])('refuses %s loudly', (_name, payload) => {
    expect(() => conversionPostedOf(event(payload))).toThrow(/malformed payload/);
  });
});
