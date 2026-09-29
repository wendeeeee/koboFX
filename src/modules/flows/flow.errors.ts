import { InvariantViolationError } from '../../common/errors';

/** Another worker holds (or took over) this flow's lease: our result must not commit. */
export class FlowLeaseLostError extends InvariantViolationError {
  constructor(flowId: string) {
    super('The flow lease was lost before the step could commit.', { flowId });
  }
}

/** The flow is no longer in the state this step was computed for (state guard). */
export class StaleFlowStateError extends InvariantViolationError {
  constructor(flowId: string, expected: string, actual: string) {
    super('The flow moved on before the step could commit.', { flowId, expected, actual });
  }
}
