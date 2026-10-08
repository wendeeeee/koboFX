import { Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';

export enum WithdrawalReviewReason {
  PROVIDER_APPROVAL_REQUIRED = 'PROVIDER_APPROVAL_REQUIRED',
  PROVIDER_RESPONSE_UNRESOLVED = 'PROVIDER_RESPONSE_UNRESOLVED',
  TRANSFER_MISMATCH = 'TRANSFER_MISMATCH',
  RECIPIENT_IDENTITY_CONFLICT = 'RECIPIENT_IDENTITY_CONFLICT',
  PROTECTED_HOLD_OVERDUE = 'PROTECTED_HOLD_OVERDUE',
  PERIOD_LOCKED = 'PERIOD_LOCKED',
  PARTIAL_RETURN = 'PARTIAL_RETURN',
  TREASURY_EVIDENCE_MISSING = 'TREASURY_EVIDENCE_MISSING',
  FEE_EVIDENCE_MISSING = 'FEE_EVIDENCE_MISSING',
}

const logger = new Logger('WithdrawalReviews');


export async function openReview(
  manager: EntityManager,
  subject: { readonly table: 'withdrawal_beneficiaries' | 'paystack_withdrawals'; readonly flowId: string },
  review: {
    readonly reason: WithdrawalReviewReason;
    readonly owner?: 'OPERATIONS' | 'SECURITY';
    readonly observationId?: string;
    readonly evidenceId?: string;
    /** `job:{name}` (default the withdrawal flow's) or `operator:{id}`. */
    readonly actor?: string;
  },
): Promise<boolean> {
  const [current] = (await manager.query(
    `SELECT review.id, review.event_kind, review.reason FROM ${subject.table} subject
       LEFT JOIN withdrawal_review_events review ON review.id = subject.current_review_event_id
      WHERE subject.flow_id = $1`,
    [subject.flowId],
  )) as { id: string | null; event_kind: string | null; reason: string | null }[];
  const open = current?.id && current.event_kind !== 'RESOLVED';
  if (open && current.reason === review.reason) return false;
  const [inserted] = (await manager.query(
    `INSERT INTO withdrawal_review_events (flow_id, event_kind, reason, owner, observation_id, evidence_id, previous_event_id, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [subject.flowId, open ? 'UPDATED' : 'OPENED', review.reason, review.owner ?? 'OPERATIONS', review.observationId ?? null,
      review.evidenceId ?? null, open ? current.id : null, review.actor ?? 'job:paystack-withdrawal-flow'],
  )) as { id: string }[];
  await manager.query(`UPDATE ${subject.table} SET current_review_event_id = $2 WHERE flow_id = $1`, [subject.flowId, inserted.id]);
  logger.warn({ flowId: subject.flowId, reason: review.reason }, 'Withdrawal review opened: needs attention');
  return true;
}

export async function resolveReview(
  manager: EntityManager,
  subject: { readonly table: 'withdrawal_beneficiaries' | 'paystack_withdrawals'; readonly flowId: string },
): Promise<void> {
  const [current] = (await manager.query(
    `SELECT review.id, review.event_kind, review.reason FROM ${subject.table} subject
       JOIN withdrawal_review_events review ON review.id = subject.current_review_event_id
      WHERE subject.flow_id = $1`,
    [subject.flowId],
  )) as { id: string; event_kind: string; reason: string }[];
  if (!current || current.event_kind === 'RESOLVED') return;
  const [inserted] = (await manager.query(
    `INSERT INTO withdrawal_review_events (flow_id, event_kind, reason, owner, previous_event_id, actor)
     VALUES ($1, 'RESOLVED', $2, 'OPERATIONS', $3, 'job:paystack-withdrawal-flow') RETURNING id`,
    [subject.flowId, current.reason, current.id],
  )) as { id: string }[];
  await manager.query(`UPDATE ${subject.table} SET current_review_event_id = $2 WHERE flow_id = $1`, [subject.flowId, inserted.id]);
}
