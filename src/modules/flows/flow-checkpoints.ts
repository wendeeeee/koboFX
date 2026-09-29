import { Injectable } from '@nestjs/common';
import { FlowCheckpoint } from './flow.types';

/**
 * The crash-injection seam (design §11: "abort the transaction or kill the step at every
 * step boundary"). A no-op in production; tests replace it to throw (abort) or never
 * return (a killed process) at a chosen boundary of a chosen state.
 */
@Injectable()
export class FlowCheckpoints {
  async reached(_point: FlowCheckpoint, _flow: { readonly flowId: string; readonly state: string }): Promise<void> {
    // Production: nothing to do.
  }
}
