import { InvariantViolationError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { AuditLogService } from '../../audit/audit-log.service';
import { LedgerService } from '../../ledger/ledger.service';
import { PaymentProvider, ProviderPayment, ProviderPaymentStatus } from '../../payments/payment-provider.port';
import { UserRepository } from '../../users/user.repository';
import { UserStatus } from '../../users/user.types';
import { FlowRunner } from '../flow-runner';
import { ClaimedFlow, FlowChange, FlowStepRuntime, FlowType } from '../flow.types';
import { FundingFlow } from './funding-flow';
import { FundingPayment, FundingPaymentRepository } from './funding-payment.repository';
import { ProviderPaymentMismatchError } from './funding.errors';

const amount = Money.of(150_000n, 'NGN');
const flow = (state: string, completedAt: Date | null = null): ClaimedFlow => ({
  id: 'flow-1', flowType: FlowType.FUNDING, state, userId: 'user-1', context: {}, attempts: 1,
  nextAttemptAt: new Date(), stateChangedAt: new Date(), completedAt, lastError: null, leaseToken: 'lease',
});
const payment = (overrides: Partial<FundingPayment> = {}): FundingPayment => ({
  flowId: 'flow-1', userId: 'user-1', accountId: 'account-1', amount, provider: 'psp', paymentMethodToken: 'tok_x',
  providerPaymentId: 'pay_1', providerStatus: null, authorizedAt: null, captureRequestedAt: null, capturedAt: null,
  failureCode: null, fundingTransactionId: null, chargebackTransactionId: null, ...overrides,
});
const pspPayment = (overrides: Partial<ProviderPayment> = {}): ProviderPayment => ({
  paymentId: 'pay_1', reference: 'flow-1', status: ProviderPaymentStatus.AUTHORIZED, amount, capturedAt: null,
  declineCode: null, chargeback: null, ...overrides,
});

function setUp(stored: FundingPayment | null, provider: Partial<PaymentProvider> = {}, status = UserStatus.ACTIVE) {
  const commits: { expected: string; change: FlowChange }[] = [];
  const runtime: FlowStepRuntime = {
    checkpoint: async () => undefined,
    commit: async (expected, change) => {
      commits.push({ expected, change });
    },
  };
  const definition = new FundingFlow(
    { register: jest.fn() } as unknown as FlowRunner,
    { findByFlowId: async () => stored, update: async () => undefined } as unknown as FundingPaymentRepository,
    provider as PaymentProvider,
    {} as LedgerService,
    { record: async () => undefined } as unknown as AuditLogService,
    { findProfile: async () => ({ status }) } as unknown as UserRepository,
  );
  return { definition, runtime, commits };
}

describe('FundingFlow — invariants and odd PSP answers (unit)', () => {
  it('refuses an unknown state and a flow without its payment row', async () => {
    const { definition, runtime } = setUp(payment());
    await expect(definition.step(flow('WEIRD'), runtime)).rejects.toThrow(InvariantViolationError);
    await expect(setUp(null).definition.step(flow('INITIATED'), runtime)).rejects.toThrow(/no funding payment/);
    expect(definition.isHintSatisfied('WEIRD', 'payment.captured')).toBe(false);
  });

  it('terminal and settled states have nothing to do', async () => {
    const { definition, runtime, commits } = setUp(payment());
    for (const state of ['SETTLED', 'FAILED', 'REVERSED']) {
      await expect(definition.step(flow(state), runtime)).resolves.toEqual({ kind: 'IDLE', state });
    }
    expect(commits).toEqual([]);
  });

  it('INITIATED with no payment at the PSP and no token left fails loudly', async () => {
    const { definition, runtime } = setUp(payment({ providerPaymentId: null, paymentMethodToken: null }), {
      findPaymentByReference: async () => null,
    });
    await expect(definition.step(flow('INITIATED'), runtime)).rejects.toThrow(/no payment method token/);
  });

  it('INITIATED re-reads a payment it already knows by id', async () => {
    const { definition, runtime, commits } = setUp(payment(), { getPayment: async () => pspPayment() });
    await expect(definition.step(flow('INITIATED'), runtime)).resolves.toEqual({ kind: 'TRANSITIONED', from: 'INITIATED', to: 'AUTHORIZED' });
    expect(commits[0].change).toEqual({ to: 'AUTHORIZED' });
  });

  it('a PSP payment that does not match (reference, id, amount, currency) is never booked', async () => {
    for (const wrong of [
      { reference: 'someone-else' },
      { paymentId: 'pay_other' },
      { amount: Money.of(150_001n, 'NGN') },
      { amount: Money.of(150_000n, 'USD') },
    ]) {
      const { definition, runtime, commits } = setUp(payment(), { getPayment: async () => pspPayment(wrong) });
      await expect(definition.step(flow('AUTHORIZED'), runtime)).rejects.toThrow(ProviderPaymentMismatchError);
      expect(commits).toEqual([]);
    }
  });

  it('AUTHORIZED: a captured payment without a capture time is refused', async () => {
    const { definition, runtime } = setUp(payment(), { getPayment: async () => pspPayment({ status: ProviderPaymentStatus.CAPTURED }) });
    await expect(definition.step(flow('AUTHORIZED'), runtime)).rejects.toThrow(/without a capture time/);
  });

  it('AUTHORIZED, suspended: a void the PSP has not applied yet is recorded as progress, re-read next time', async () => {
    const { definition, runtime, commits } = setUp(
      payment(),
      { getPayment: async () => pspPayment(), void: async () => pspPayment({ status: ProviderPaymentStatus.AUTHORIZED }) },
      UserStatus.SUSPENDED,
    );
    await expect(definition.step(flow('AUTHORIZED'), runtime)).resolves.toEqual({ kind: 'PROGRESSED', state: 'AUTHORIZED' });
    expect(commits[0].change).toEqual({ retryInSeconds: 0, complete: false });
  });

  it('AUTHORIZED, capture already requested and still pending: waits without committing', async () => {
    const { definition, runtime, commits } = setUp(
      payment({ captureRequestedAt: new Date(), providerStatus: ProviderPaymentStatus.CAPTURE_PENDING }),
      { getPayment: async () => pspPayment({ status: ProviderPaymentStatus.CAPTURE_PENDING }) },
    );
    await expect(definition.step(flow('AUTHORIZED'), runtime)).resolves.toMatchObject({ kind: 'WAITING', retryInSeconds: 5 });
    expect(commits).toEqual([]);
  });

  it('missing facts a later state depends on are invariant violations', async () => {
    await expect(setUp(payment({ providerPaymentId: null })).definition.step(flow('AUTHORIZED'), setUp(null).runtime)).rejects.toThrow(/no PSP payment id/);
    await expect(setUp(payment({ capturedAt: null })).definition.step(flow('CAPTURED'), setUp(null).runtime)).rejects.toThrow(/no capture time/);
    await expect(setUp(payment({ fundingTransactionId: null })).definition.step(flow('POSTED'), setUp(null).runtime)).rejects.toThrow(/has no transaction/);
  });

  it('POSTED without a chargeback: an open flow is completed; a completed one is idle', async () => {
    const provider = { getPayment: async () => pspPayment({ status: ProviderPaymentStatus.CAPTURED, capturedAt: new Date() }) };
    const open = setUp(payment({ fundingTransactionId: 'tx-1' }), provider);
    await expect(open.definition.step(flow('POSTED'), open.runtime)).resolves.toEqual({ kind: 'PROGRESSED', state: 'POSTED' });
    expect(open.commits[0].change).toEqual({ retryInSeconds: 0, complete: true });
    const done = setUp(payment({ fundingTransactionId: 'tx-1' }), provider);
    await expect(done.definition.step(flow('POSTED', new Date()), done.runtime)).resolves.toEqual({ kind: 'IDLE', state: 'POSTED' });
  });
});
