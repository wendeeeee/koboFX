import {
  ReconciliationCheckpoint,
  ReconciliationCheckpointContext,
  ReconciliationCheckpoints,
} from '../../src/modules/reconciliation/reconciliation-checkpoints';

/** A crash injected at a reconciliation step boundary (design §11). */
export class InjectedReconciliationCrash extends Error {
  constructor(point: ReconciliationCheckpoint, kind: string) {
    super(`Injected crash at ${point} in a ${kind} run`);
    this.name = 'InjectedReconciliationCrash';
  }
}

/** Records every boundary reached and throws once at an armed one (then the run is resumed). */
export class ScriptedReconciliationCheckpoints extends ReconciliationCheckpoints {
  readonly log: { point: ReconciliationCheckpoint; runId: string; kind: string }[] = [];
  private armed: { point: ReconciliationCheckpoint; kind?: string } | undefined;
  private firedCount = 0;

  arm(point: ReconciliationCheckpoint, kind?: string): void {
    this.armed = { point, ...(kind ? { kind } : {}) };
  }

  disarm(): void {
    this.armed = undefined;
  }

  get fired(): number {
    return this.firedCount;
  }

  override async reached(point: ReconciliationCheckpoint, context: ReconciliationCheckpointContext): Promise<void> {
    this.log.push({ point, runId: context.runId, kind: context.kind });
    const armed = this.armed;
    if (!armed || armed.point !== point || (armed.kind !== undefined && armed.kind !== context.kind)) return;
    this.armed = undefined;
    this.firedCount += 1;
    throw new InjectedReconciliationCrash(point, context.kind);
  }
}
