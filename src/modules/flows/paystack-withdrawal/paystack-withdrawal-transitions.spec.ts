import {
  PAYSTACK_BENEFICIARY_STATES,
  PaystackBeneficiaryState,
  assertBeneficiaryTransition,
  beneficiaryStatusOf,
  isPaystackBeneficiaryState,
} from '../paystack-beneficiary/paystack-beneficiary-transitions';
import {
  PAYSTACK_WITHDRAWAL_COMPLETION_STATES,
  PAYSTACK_WITHDRAWAL_HOLDING_STATES,
  PAYSTACK_WITHDRAWAL_STATES,
  PaystackWithdrawalState,
  assertWithdrawalTransition,
  isPaystackWithdrawalState,
  paystackWithdrawalTransitions,
  withdrawalStatusOf,
} from './paystack-withdrawal-transitions';

describe('Paystack withdrawal transitions', () => {
  it('lists exactly the approved pairs (the SQL mirror is checked pair for pair in withdrawal-schema.int-spec)', () => {
    expect(paystackWithdrawalTransitions()).toEqual([
      ['RESERVED', 'SUBMITTING'],
      ['RESERVED', 'FAILED'],
      ['SUBMITTING', 'PROCESSING'],
      ['SUBMITTING', 'POSTED'],
      ['SUBMITTING', 'FAILED'],
      ['PROCESSING', 'POSTED'],
      ['PROCESSING', 'FAILED'],
      ['POSTED', 'REVERSED'],
    ]);
  });

  it('has no RESERVED → POSTED shortcut and no way out of FAILED or REVERSED', () => {
    expect(() => assertWithdrawalTransition(PaystackWithdrawalState.RESERVED, PaystackWithdrawalState.POSTED)).toThrow(
      /cannot move from RESERVED to POSTED/,
    );
    for (const to of PAYSTACK_WITHDRAWAL_STATES) {
      expect(() => assertWithdrawalTransition(PaystackWithdrawalState.FAILED, to)).toThrow();
      expect(() => assertWithdrawalTransition(PaystackWithdrawalState.REVERSED, to)).toThrow();
    }
    expect(() => assertWithdrawalTransition(PaystackWithdrawalState.PROCESSING, PaystackWithdrawalState.POSTED)).not.toThrow();
  });

  it('maps every state to one public status; holding and completion states partition the machine', () => {
    expect(PAYSTACK_WITHDRAWAL_STATES.map(withdrawalStatusOf)).toEqual(['PENDING', 'PENDING', 'PENDING', 'COMPLETED', 'FAILED', 'REVERSED']);
    expect([...PAYSTACK_WITHDRAWAL_HOLDING_STATES, ...PAYSTACK_WITHDRAWAL_COMPLETION_STATES].sort()).toEqual([...PAYSTACK_WITHDRAWAL_STATES].sort());
    expect(isPaystackWithdrawalState('POSTED')).toBe(true);
    expect(isPaystackWithdrawalState('SETTLED')).toBe(false);
  });
});

describe('Paystack beneficiary transitions', () => {
  it('walks REQUESTED → RESOLVED → CREATING → READY; READY and FAILED are final', () => {
    expect(() => assertBeneficiaryTransition(PaystackBeneficiaryState.REQUESTED, PaystackBeneficiaryState.READY)).toThrow();
    expect(() => assertBeneficiaryTransition(PaystackBeneficiaryState.CREATING, PaystackBeneficiaryState.READY)).not.toThrow();
    for (const to of PAYSTACK_BENEFICIARY_STATES) {
      expect(() => assertBeneficiaryTransition(PaystackBeneficiaryState.READY, to)).toThrow();
    }
    expect(PAYSTACK_BENEFICIARY_STATES.map(beneficiaryStatusOf)).toEqual(['PENDING', 'PENDING', 'PENDING', 'READY', 'FAILED']);
    expect(isPaystackBeneficiaryState('READY')).toBe(true);
    expect(isPaystackBeneficiaryState('HELD')).toBe(false);
  });
});
