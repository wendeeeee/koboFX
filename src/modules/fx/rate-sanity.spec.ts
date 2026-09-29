import { Dec, MoneyDecimal, dec } from '../../common/money';
import { ParsedRates } from './providers/exchange-rate-api.responses';
import { SanityContext, checkSanity } from './rate-sanity';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const ACTIVE = ['EUR', 'GBP', 'NGN', 'USD'];
const bound = (minimum: string, maximum: string) => ({ minimum: dec(minimum), maximum: dec(maximum) });
const BOUNDS = new Map([
  ['USD', bound('1', '1')],
  ['NGN', bound('100', '100000')],
  ['EUR', bound('0.1', '10')],
  ['GBP', bound('0.1', '10')],
]);

function snapshot(rates: Record<string, string>, overrides: Partial<ParsedRates> = {}): ParsedRates {
  return {
    kind: 'SUCCESS',
    baseCurrency: 'USD',
    providerUpdatedAt: new Date(NOW.getTime() - 3_600_000),
    providerNextUpdateAt: new Date(NOW.getTime() + 3_600_000),
    rates: new Map(Object.entries(rates).map(([code, rate]) => [code, dec(rate)] as [string, Dec])),
    malformedRates: [],
    ...overrides,
  };
}

const GOOD = { USD: '1', NGN: '1329.375909', EUR: '0.879241', GBP: '0.754467' };

function context(overrides: Partial<SanityContext> = {}): SanityContext {
  return {
    now: NOW,
    activeCurrencies: ACTIVE,
    bounds: BOUNDS,
    maximumJumpRatio: dec('0.20'),
    jumpRatioOverrides: new Map(),
    cadenceSeconds: 86_400,
    ...overrides,
  };
}

const previous = (rates: Record<string, string>, providerUpdatedAt = new Date(NOW.getTime() - 90_000_000)) => ({
  providerUpdatedAt,
  rates: new Map(Object.entries(rates).map(([code, rate]) => [code, dec(rate)] as [string, Dec])),
});

describe('rate sanity checks (design §7.4, Phase 6 §5.5)', () => {
  it('accepts a plausible first fetch — no history, bounds only (the baseline)', () => {
    expect(checkSanity(snapshot(GOOD), context())).toEqual({ accepted: true, reasons: [], deviations: new Map() });
  });

  it.each([
    ['base not USD', snapshot(GOOD, { baseCurrency: 'EUR' }), 'BASE_CURRENCY_NOT_USD'],
    ['USD not exactly 1', snapshot({ ...GOOD, USD: '1.0001' }), 'USD_RATE_NOT_ONE'],
    ['USD missing', snapshot({ NGN: '1329', EUR: '0.87', GBP: '0.75' }), 'USD_RATE_NOT_ONE'],
    ['an active currency missing', snapshot({ USD: '1', EUR: '0.87', GBP: '0.75' }), 'RATE_MISSING:NGN'],
    ['a malformed rate', snapshot({ USD: '1', EUR: '0.87', GBP: '0.75' }, { malformedRates: ['NGN'] }), 'RATE_MALFORMED:NGN'],
    ['a zero rate', snapshot({ ...GOOD, NGN: '0' }), 'RATE_NOT_POSITIVE:NGN'],
    ['a negative rate', snapshot({ ...GOOD, EUR: '-0.87' }), 'RATE_NOT_POSITIVE:EUR'],
    ['below bounds (a kobo-per-dollar typo)', snapshot({ ...GOOD, NGN: '13.29375909' }), 'RATE_OUT_OF_BOUNDS:NGN'],
    ['above bounds', snapshot({ ...GOOD, GBP: '75.4467' }), 'RATE_OUT_OF_BOUNDS:GBP'],
    ['provider time in the future', snapshot(GOOD, { providerUpdatedAt: new Date(NOW.getTime() + 61_000), providerNextUpdateAt: new Date(NOW.getTime() + 3_600_000) }), 'PROVIDER_TIME_IN_FUTURE'],
    ['next update before last update', snapshot(GOOD, { providerNextUpdateAt: new Date(NOW.getTime() - 3_600_000) }), 'NEXT_UPDATE_IMPLAUSIBLE'],
    ['next update absurdly far away', snapshot(GOOD, { providerNextUpdateAt: new Date(NOW.getTime() + 3 * 86_400_000) }), 'NEXT_UPDATE_IMPLAUSIBLE'],
  ])('rejects %s', (_name, parsed, reason) => {
    const verdict = checkSanity(parsed, context());
    expect(verdict.accepted).toBe(false);
    expect(verdict.reasons).toContain(reason);
  });

  it('tolerates 60s of clock skew on the provider time', () => {
    const skewed = snapshot(GOOD, { providerUpdatedAt: new Date(NOW.getTime() + 60_000) });
    expect(checkSanity(skewed, context()).accepted).toBe(true);
  });

  it('a currency without configured bounds fails loudly', () => {
    const verdict = checkSanity(snapshot(GOOD), context({ bounds: new Map([...BOUNDS].filter(([code]) => code !== 'GBP')) }));
    expect(verdict.reasons).toEqual(['BOUNDS_NOT_CONFIGURED:GBP']);
  });

  it('inactive currencies are not judged: a broken rate for a currency we do not use is ignored', () => {
    const parsed = snapshot({ ...GOOD, JPY: '0' }, { malformedRates: ['KWD'] });
    expect(checkSanity(parsed, context()).accepted).toBe(true);
  });

  it('reports every broken rule at once', () => {
    const verdict = checkSanity(snapshot({ USD: '2', NGN: '-1' }, { baseCurrency: 'GBP' }), context());
    expect(verdict.reasons).toEqual(['BASE_CURRENCY_NOT_USD', 'USD_RATE_NOT_ONE', 'RATE_MISSING:EUR', 'RATE_MISSING:GBP', 'RATE_NOT_POSITIVE:NGN', 'RATE_OUT_OF_BOUNDS:USD']);
  });

  describe('the jump rule: > 20% from the last ACCEPTED value', () => {
    const last = { ...GOOD, NGN: '1000' };

    it('exactly 20% passes; a hair more is rejected — in either direction', () => {
      expect(checkSanity(snapshot({ ...GOOD, NGN: '1200' }), context({ previous: previous(last) })).accepted).toBe(true);
      expect(checkSanity(snapshot({ ...GOOD, NGN: '800' }), context({ previous: previous(last) })).accepted).toBe(true);
      expect(checkSanity(snapshot({ ...GOOD, NGN: '1200.0001' }), context({ previous: previous(last) })).reasons).toEqual(['RATE_JUMP:NGN']);
      expect(checkSanity(snapshot({ ...GOOD, NGN: '799.9999' }), context({ previous: previous(last) })).reasons).toEqual(['RATE_JUMP:NGN']);
    });

    it('records the deviation ratio of every currency with history (fx_provider_deviation_ratio)', () => {
      const verdict = checkSanity(snapshot({ ...GOOD, NGN: '1100' }), context({ previous: previous(last) }));
      expect(verdict.deviations.get('NGN')?.toFixed()).toBe('0.1');
      expect(verdict.deviations.get('USD')?.toFixed()).toBe('0');
    });

    it('a per-currency override replaces the global threshold', () => {
      const overrides = new Map([['NGN', new MoneyDecimal('0.35')]]);
      expect(checkSanity(snapshot({ ...GOOD, NGN: '1300' }), context({ previous: previous(last), jumpRatioOverrides: overrides })).accepted).toBe(true);
      expect(checkSanity(snapshot({ ...GOOD, EUR: '1.1' }), context({ previous: previous(last), jumpRatioOverrides: overrides })).reasons).toEqual(['RATE_JUMP:EUR']);
    });

    it('a genuine move (NGN, 2023) is rejected every time — repetition never accepts it', () => {
      const devalued = snapshot({ ...GOOD, NGN: '1500' });
      for (let fetch = 0; fetch < 5; fetch += 1) {
        // The history stays the last ACCEPTED snapshot, so the verdict never changes.
        expect(checkSanity(devalued, context({ previous: previous(last) })).reasons).toEqual(['RATE_JUMP:NGN']);
      }
    });

    it('after a long outage the old value is still the reference (no auto-widening)', () => {
      const weekOld = previous(last, new Date(NOW.getTime() - 7 * 86_400_000));
      expect(checkSanity(snapshot({ ...GOOD, NGN: '1250' }), context({ previous: weekOld })).reasons).toEqual(['RATE_JUMP:NGN']);
    });

    it('time never runs backwards', () => {
      const newer = previous(last, new Date(NOW.getTime() - 60_000));
      expect(checkSanity(snapshot({ ...GOOD, NGN: '1000' }), context({ previous: newer })).reasons).toEqual(['PROVIDER_TIME_REGRESSED']);
    });
  });
});
