import { InvariantViolationError, ResourceBusyError } from '../../common/errors';

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

/** A worker holds a live lease on the flow: an approved transition waits for it (transient, retried), never interleaves. */
export class FlowLeasedError extends ResourceBusyError {
  constructor(flowId: string) {
    super('A worker is processing this flow right now; retry shortly.', { flowId });
  }
}

export class FlowNotFoundError extends InvariantViolationError {
  constructor(flowId: string) {
    super('No such flow.', { flowId });
  }
}
