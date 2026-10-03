import { FlowCheckpoints } from '../../src/modules/flows/flow-checkpoints';
import { FlowCheckpoint } from '../../src/modules/flows/flow.types';

/** A crash injected at a step boundary (design §11). */
export class InjectedCrash extends Error {
  constructor(point: FlowCheckpoint, state: string) {
    super(`Injected crash at ${point} in ${state}`);
    this.name = 'InjectedCrash';
  }
}

export interface CrashPlan {
  readonly state: string;
  readonly point: FlowCheckpoint;
  readonly mode: 'throw' | 'hang' | 'pause';
}

export class ScriptedFlowCheckpoints extends FlowCheckpoints {
  readonly log: { point: FlowCheckpoint; state: string; flowId: string }[] = [];
  private plan: CrashPlan | undefined;
  private fired = false;
  private onFired: (() => void) | undefined;
  private resumePaused: (() => void) | undefined;

  arm(plan: CrashPlan): Promise<void> {
    this.plan = plan;
    this.fired = false;
    return new Promise((resolve) => {
      this.onFired = resolve;
    });
  }

  disarm(): void {
    this.plan = undefined;
  }

  resume(): void {
    this.resumePaused?.();
  }

  get hasFired(): boolean {
    return this.fired;
  }

  override async reached(point: FlowCheckpoint, flow: { flowId: string; state: string }): Promise<void> {
    this.log.push({ point, state: flow.state, flowId: flow.flowId });
    const plan = this.plan;
    if (!plan || this.fired || plan.point !== point || plan.state !== flow.state) return;
    this.fired = true;
    this.plan = undefined;
    this.onFired?.();
    if (plan.mode === 'throw') throw new InjectedCrash(point, flow.state);
    if (plan.mode === 'pause') {
      await new Promise<void>((resolve) => {
        this.resumePaused = resolve;
      });
      return;
    }
    await new Promise<never>(() => undefined);
  }
}
