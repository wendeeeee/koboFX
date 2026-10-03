import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { FlowLeaseLostError, StaleFlowStateError } from './flow.errors';
import { ClaimedFlow, FlowChange, FlowInstance, FlowType } from './flow.types';

interface FlowRow {
  id: string;
  flow_type: FlowType;
  state: string;
  user_id: string;
  context: Record<string, unknown>;
  attempts: number;
  next_attempt_at: Date;
  state_changed_at: Date;
  completed_at: Date | null;
  last_error: string | null;
  lease_token: string | null;
}

const COLUMNS = `flow_instances.id, flow_instances.flow_type, flow_instances.state, flow_instances.user_id,
  flow_instances.context, flow_instances.attempts, flow_instances.next_attempt_at, flow_instances.state_changed_at,
  flow_instances.completed_at, flow_instances.last_error, flow_instances.lease_token`;

const MAXIMUM_ERROR_LENGTH = 500;

function toFlow(row: FlowRow): FlowInstance {
  return {
    id: row.id,
    flowType: row.flow_type,
    state: row.state,
    userId: row.user_id,
    context: row.context,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    stateChangedAt: row.state_changed_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}

function toClaimed(row: FlowRow): ClaimedFlow {
  return { ...toFlow(row), leaseToken: row.lease_token as string };
}


@Injectable()
export class FlowRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async create(
    flowType: FlowType,
    userId: string,
    initialState: string,
    context: Record<string, unknown> = {},
  ): Promise<FlowInstance> {
    const [row] = (await this.unitOfWork.requireTransaction().query(
      `INSERT INTO flow_instances (flow_type, state, user_id, context) VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNS}`,
      [flowType, initialState, userId, JSON.stringify(context)],
    )) as FlowRow[];
    return toFlow(row);
  }

  async findById(flowId: string): Promise<FlowInstance | null> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT ${COLUMNS} FROM flow_instances WHERE id = $1`, [
      flowId,
    ])) as FlowRow[];
    return row ? toFlow(row) : null;
  }

  async completeSynchronous(flowId: string, expectedState: string, completionState: string): Promise<void> {
    const rows = (await this.unitOfWork.requireTransaction().query(
      `WITH updated AS (
         UPDATE flow_instances
            SET state = $3, state_changed_at = now(), completed_at = now(), updated_at = now()
          WHERE id = $1 AND state = $2 AND completed_at IS NULL AND lease_token IS NULL
          RETURNING id
       )
       SELECT id FROM updated`,
      [flowId, expectedState, completionState],
    )) as { id: string }[];
    if (rows.length !== 1) throw new StaleFlowStateError(flowId, expectedState, 'unknown');
  }


  async claimDue(batchSize: number, leaseSeconds: number): Promise<ClaimedFlow[]> {
    const rows = (await this.unitOfWork.manager.query(
      `WITH due AS (
         SELECT id FROM flow_instances
          WHERE completed_at IS NULL AND next_attempt_at <= now()
            AND (leased_until IS NULL OR leased_until < now())
          ORDER BY next_attempt_at, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE flow_instances
            SET leased_until = now() + make_interval(secs => $2), lease_token = gen_random_uuid(),
                attempts = flow_instances.attempts + 1, updated_at = now()
           FROM due
          WHERE flow_instances.id = due.id
         RETURNING ${COLUMNS}
       )
       SELECT * FROM claimed ORDER BY next_attempt_at, id`,
      [batchSize, leaseSeconds],
    )) as FlowRow[];
    return rows.map(toClaimed);
  }


  async claimOne(flowId: string, leaseSeconds: number, includeCompleted: boolean): Promise<ClaimedFlow | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `WITH target AS (
         SELECT id FROM flow_instances
          WHERE id = $1 AND (leased_until IS NULL OR leased_until < now())
            AND ($3 OR completed_at IS NULL)
          FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE flow_instances
            SET leased_until = now() + make_interval(secs => $2), lease_token = gen_random_uuid(),
                attempts = flow_instances.attempts + 1, updated_at = now()
           FROM target
          WHERE flow_instances.id = target.id
         RETURNING ${COLUMNS}
       )
       SELECT * FROM claimed`,
      [flowId, leaseSeconds, includeCompleted],
    )) as FlowRow[];
    return row ? toClaimed(row) : null;
  }

  async commit(
    flow: ClaimedFlow,
    expectedState: string,
    change: FlowChange,
    work: ((manager: EntityManager) => Promise<void>) | undefined,
    beforeCommit: () => Promise<void>,
  ): Promise<void> {
    await this.unitOfWork.run(async (manager) => {
      const [row] = (await manager.query(`SELECT state, lease_token FROM flow_instances WHERE id = $1 FOR UPDATE`, [
        flow.id,
      ])) as { state: string; lease_token: string | null }[];
      if (row.lease_token !== flow.leaseToken) throw new FlowLeaseLostError(flow.id);
      if (row.state !== expectedState) throw new StaleFlowStateError(flow.id, expectedState, row.state);
      if (work) await work(manager);
      const transition = change.to !== undefined && change.to !== expectedState;
      await manager.query(
        `UPDATE flow_instances
            SET state = $2,
                state_changed_at = CASE WHEN $3 THEN now() ELSE state_changed_at END,
                attempts = CASE WHEN $3 THEN 0 ELSE attempts END,
                completed_at = CASE WHEN $4 THEN coalesce(completed_at, now()) ELSE completed_at END,
                next_attempt_at = now() + make_interval(secs => $5),
                last_error = $6,
                leased_until = NULL, lease_token = NULL, updated_at = now()
          WHERE id = $1`,
        [flow.id, change.to ?? expectedState, transition, change.complete === true, change.retryInSeconds ?? 0, change.note ?? null],
      );
      await beforeCommit();
    });
  }

  async release(flow: ClaimedFlow, retryInSeconds: number, note: string | null): Promise<void> {
    await this.unitOfWork.manager.query(
      `UPDATE flow_instances
          SET leased_until = NULL, lease_token = NULL, next_attempt_at = now() + make_interval(secs => $3),
              last_error = $4, updated_at = now()
        WHERE id = $1 AND lease_token = $2`,
      [flow.id, flow.leaseToken, retryInSeconds, note?.slice(0, MAXIMUM_ERROR_LENGTH) ?? null],
    );
  }
}
