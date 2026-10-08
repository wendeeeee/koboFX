import { RateTier, ageSeconds, freshnessOf } from './freshness';

const PUBLISHED = new Date('2026-09-29T12:00:00.000Z');
const at = (seconds: number) => new Date(PUBLISHED.getTime() + seconds * 1000);

const DESIGN = { executableMaximumAgeSeconds: 120, displayMaximumAgeSeconds: 900, publicationGraceSeconds: 60 };
const snapshot = { providerUpdatedAt: PUBLISHED, providerNextUpdateAt: at(300) };

describe('freshness tiers (design §7.4 as redefined in Phase 6 §5.2)', () => {
  it.each([
    [119, RateTier.EXECUTABLE],
    [120, RateTier.EXECUTABLE],
    [121, RateTier.DISPLAY_ONLY],
    [899, RateTier.DISPLAY_ONLY],
    [900, RateTier.DISPLAY_ONLY],
    [901, RateTier.UNSERVABLE],
  ])('at %ss after publication the rate is %s (both limits inclusive)', (seconds, tier) => {
    expect(freshnessOf(snapshot, at(seconds), DESIGN).tier).toBe(tier);
  });

  it('boundaries hold to the millisecond', () => {
    expect(freshnessOf(snapshot, new Date(at(120).getTime() + 1), DESIGN).tier).toBe(RateTier.DISPLAY_ONLY);
    expect(freshnessOf(snapshot, new Date(at(900).getTime() + 1), DESIGN).tier).toBe(RateTier.UNSERVABLE);
  });

  it('a young rate is NOT executable once a newer publication may exist that we have not fetched', () => {
    const lateNext = { providerUpdatedAt: PUBLISHED, providerNextUpdateAt: at(30) };
    expect(freshnessOf(lateNext, at(89), DESIGN)).toMatchObject({ tier: RateTier.EXECUTABLE, isCurrentPublication: true });
    expect(freshnessOf(lateNext, at(90), DESIGN)).toMatchObject({ tier: RateTier.DISPLAY_ONLY, isCurrentPublication: false });
  });

  it('age is measured from the provider publication time, never negative, reported rounded up', () => {
    const early = freshnessOf(snapshot, new Date(PUBLISHED.getTime() - 5_000), DESIGN);
    expect(early.ageMilliseconds).toBe(0);
    expect(ageSeconds(freshnessOf(snapshot, new Date(PUBLISHED.getTime() + 200), DESIGN))).toBe(1);
    expect(ageSeconds(freshnessOf(snapshot, at(15 * 60), DESIGN))).toBe(900);
  });

  it('the Business plan defaults (420s / 900s, grace 120s) at their boundaries ± 1s', () => {
    const business = { executableMaximumAgeSeconds: 420, displayMaximumAgeSeconds: 900, publicationGraceSeconds: 120 };
    const fiveMinute = { providerUpdatedAt: PUBLISHED, providerNextUpdateAt: at(300) };
    expect(freshnessOf(fiveMinute, at(419), business).tier).toBe(RateTier.EXECUTABLE);
    expect(freshnessOf(fiveMinute, at(420), business).tier).toBe(RateTier.DISPLAY_ONLY);
    expect(freshnessOf(fiveMinute, at(901), business).tier).toBe(RateTier.UNSERVABLE);
  });
});
