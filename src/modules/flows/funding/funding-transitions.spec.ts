import {
  FUNDING_COMPLETION_STATES,
  FUNDING_STATES,
  FUNDING_TERMINAL_STATES,
  FundingState,
  assertTransition,
  canTransition,
  fundingStatusOf,
  fundingTransitions,
  isFundingHintSatisfied,
  isFundingState,
} from './funding-transitions';

const LEGAL = new Set([
  'INITIATED→AUTHORIZED',
  'INITIATED→FAILED',
  'AUTHORIZED→CAPTURED',
  'AUTHORIZED→FAILED',
  'CAPTURED→POSTED',
  'POSTED→SETTLED',
  'POSTED→REVERSED',
  'SETTLED→REVERSED',
]);

describe('funding transition table (design §7.5)', () => {
  it('allows exactly the approved transitions — every pair of states checked, not a sample', () => {
    let checked = 0;
    for (const from of FUNDING_STATES) {
      for (const to of FUNDING_STATES) {
        const expected = LEGAL.has(`${from}→${to}`);
        expect({ from, to, allowed: canTransition(from, to) }).toEqual({ from, to, allowed: expected });
        if (expected) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(/cannot move/);
        checked += 1;
      }
    }
    expect(checked).toBe(49);
    expect(fundingTransitions().map(([from, to]) => `${from}→${to}`).sort()).toEqual([...LEGAL].sort());
  });

  it('terminal states are terminal: FAILED and REVERSED have no way out, and nothing re-enters INITIATED', () => {
    expect([...FUNDING_TERMINAL_STATES].sort()).toEqual([FundingState.FAILED, FundingState.REVERSED]);
    for (const terminal of FUNDING_TERMINAL_STATES) {
      for (const to of FUNDING_STATES) expect(canTransition(terminal, to)).toBe(false);
    }
    for (const from of FUNDING_STATES) expect(canTransition(from, FundingState.INITIATED)).toBe(false);
    expect(FUNDING_STATES.filter((from) => canTransition(from, FundingState.POSTED))).toEqual([FundingState.CAPTURED]);
  });

  it('completion states are where the resumer stops (Phase 5 stops at POSTED)', () => {
    expect([...FUNDING_COMPLETION_STATES].sort()).toEqual(['FAILED', 'POSTED', 'REVERSED', 'SETTLED']);
  });

  it('maps states to the client-facing status', () => {
    expect(FUNDING_STATES.map((state) => [state, fundingStatusOf(state)])).toEqual([
      ['INITIATED', 'PENDING'],
      ['AUTHORIZED', 'PENDING'],
      ['CAPTURED', 'PENDING'],
      ['POSTED', 'COMPLETED'],
      ['SETTLED', 'COMPLETED'],
      ['FAILED', 'FAILED'],
      ['REVERSED', 'REVERSED'],
    ]);
    expect(isFundingState('POSTED')).toBe(true);
    expect(isFundingState('posted')).toBe(false);
  });

  it('a webhook hint is satisfied at or beyond what it hints, and by any terminal state (never backwards)', () => {
    const satisfied = (eventType: string) => FUNDING_STATES.filter((state) => isFundingHintSatisfied(state, eventType));
    expect(satisfied('payment.authorized')).toEqual(['AUTHORIZED', 'CAPTURED', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED']);
    expect(satisfied('payment.capture_pending')).toEqual(['AUTHORIZED', 'CAPTURED', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED']);
    expect(satisfied('payment.captured')).toEqual(['POSTED', 'SETTLED', 'FAILED', 'REVERSED']);
    for (const failure of ['payment.declined', 'payment.expired', 'payment.voided', 'payment.capture_failed']) {
      expect(satisfied(failure)).toEqual(['POSTED', 'SETTLED', 'FAILED', 'REVERSED']);
    }
    expect(satisfied('payment.charged_back')).toEqual(['FAILED', 'REVERSED']);
    expect(satisfied('payment.something_new')).toEqual(FUNDING_STATES);
  });
});
