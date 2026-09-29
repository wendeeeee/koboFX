import { InvariantViolationError } from '../../common/errors';
import { AppConfig } from '../../config/configuration';
import { ProviderUnavailableError } from '../payments/payment.errors';
import { FlowCheckpoints } from './flow-checkpoints';
import { FlowRunner } from './flow-runner';
import { FlowLeaseLostError } from './flow.errors';
import { FlowRepository } from './flow.repository';
import { ClaimedFlow, FlowDefinition, FlowType, StepOutcome } from './flow.types';

const config = { flows: { leaseSeconds: 60, maximumBackoffSeconds: 900 } } as AppConfig;
const claimed: ClaimedFlow = {
  id: 'flow-1', flowType: FlowType.FUNDING, state: 'AUTHORIZED', userId: 'user-1', context: {}, attempts: 3,
  nextAttemptAt: new Date(), stateChangedAt: new Date(), completedAt: null, lastError: null, leaseToken: 'lease',
};

function runnerWith(step: () => Promise<StepOutcome>, release = jest.fn(async () => undefined), claimOne = jest.fn(async () => claimed as ClaimedFlow | null)) {
  const repository = { release, claimOne, commit: jest.fn() } as unknown as FlowRepository;
  const runner = new FlowRunner(repository, new FlowCheckpoints(), config);
  runner.register({ flowType: FlowType.FUNDING, step, isHintSatisfied: () => false } as FlowDefinition);
  return { runner, release, claimOne };
}

describe('FlowRunner (unit)', () => {
  it('refuses a second definition for one flow type, and an unknown type', () => {
    const { runner } = runnerWith(async () => ({ kind: 'IDLE', state: 'X' }));
    expect(() => runner.register({ flowType: FlowType.FUNDING } as FlowDefinition)).toThrow(InvariantViolationError);
    expect(() => new FlowRunner({} as FlowRepository, new FlowCheckpoints(), config).definitionFor(FlowType.FUNDING)).toThrow(/No flow definition/);
  });

  it('a lost lease discards the result and releases nothing', async () => {
    const { runner, release } = runnerWith(async () => {
      throw new FlowLeaseLostError('flow-1');
    });
    await expect(runner.runClaimed(claimed)).resolves.toMatchObject({ kind: 'WAITING', state: 'AUTHORIZED' });
    expect(release).not.toHaveBeenCalled();
  });

  it('a failing step gives the lease back with exponential backoff; a failing release is survived', async () => {
    const release = jest.fn(async () => {
      throw new Error('database blip');
    });
    const { runner } = runnerWith(async () => {
      throw new ProviderUnavailableError('PSP down', 'get-payment');
    }, release);
    await expect(runner.runClaimed(claimed)).resolves.toEqual({
      kind: 'WAITING', state: 'AUTHORIZED', reason: 'ProviderUnavailableError: PSP down', retryInSeconds: 20,
    });
    expect(release).toHaveBeenCalledWith(claimed, 20, 'ProviderUnavailableError: PSP down');
    const other = runnerWith(async () => {
      throw 'not an Error';
    });
    await expect(other.runner.runClaimed(claimed)).resolves.toMatchObject({ reason: 'not an Error' });
  });

  it('an idle step releases with no error note; an unclaimable flow is NOT_CLAIMED', async () => {
    const { runner, release } = runnerWith(async () => ({ kind: 'IDLE', state: 'AUTHORIZED' }));
    await runner.runClaimed(claimed);
    expect(release).toHaveBeenCalledWith(claimed, 20, null);
    const none = runnerWith(async () => ({ kind: 'IDLE', state: 'X' }), undefined, jest.fn(async () => null));
    await expect(none.runner.advance('flow-1')).resolves.toEqual({ kind: 'NOT_CLAIMED' });
  });
});
