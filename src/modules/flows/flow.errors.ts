import { InvariantViolationError } from '../../common/errors';

export class FlowLeaseLostError extends InvariantViolationError {
  constructor(flowId: string) {
    super('The flow lease was lost before the step could commit.', { flowId });
  }
}

export class StaleFlowStateError extends InvariantViolationError {
  constructor(flowId: string, expected: string, actual: string) {
    super('The flow moved on before the step could commit.', { flowId, expected, actual });
  }
}
