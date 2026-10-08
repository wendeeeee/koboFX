import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ApprovalActionType } from '../approvals/approval.types';
import { CorrectionMode, RateOverrideMode, RoleChangeOperation, WithdrawalRecoveryMode } from './action-payloads';

/**
 * The OpenAPI (JSON Schema) twin of `action-payloads.ts` (Phase 11 plan §E): hand-written, no generator.
 * `action-payload.schemas.spec.ts` keeps them equal — same properties, same required set, strict — and every example
 * below must pass `parseActionPayload` AND these schemas. The Zod schemas stay the truth: where JSON Schema cannot say
 * a rule (two currencies must differ, "at least one of"), the description does and the test pins the Zod refusal.
 */
const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const minorUnits: SchemaObject = {
  type: 'string',
  pattern: '^[1-9]\\d{0,17}$',
  description: 'A positive whole number of minor units, as a string (never a JSON number).',
};
const currency: SchemaObject = { type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO 4217 code.' };
const instant: SchemaObject = { type: 'string', format: 'date-time', description: 'ISO-8601 with an offset.' };
const rate: SchemaObject = {
  type: 'string',
  maxLength: 40,
  pattern: '^(0|[1-9]\\d*)(\\.\\d+)?$',
  description: 'A USD-based mid (units of the currency per 1 USD): a plain positive decimal, as a string.',
};
const valueTime: SchemaObject = { ...instant, description: 'The posting\'s value time (ISO-8601 with an offset). Refused in a closed period — never re-dated.' };

function strict(properties: Record<string, SchemaObject>, required: string[] = Object.keys(properties), extra: Partial<SchemaObject> = {}): SchemaObject {
  return { type: 'object', additionalProperties: false, required, properties, ...extra };
}

const correctionVariant = (mode: CorrectionMode, description: string, extra: Record<string, SchemaObject> = {}): SchemaObject =>
  strict({ mode: { type: 'string', enum: [mode] }, breakId: { ...uuid, description: 'The reconciliation break it fixes (must be live).' }, ...extra, valueTime }, undefined, {
    description,
  });

const recoveryVariant = (mode: WithdrawalRecoveryMode, description: string, lateFact: boolean): SchemaObject =>
  strict(
    {
      mode: { type: 'string', enum: [mode] },
      withdrawalId: { ...uuid, description: 'The withdrawal (its flow id).' },
      breakId: { ...uuid, description: 'The live reconciliation break about this withdrawal.' },
      observationId: {
        ...uuid,
        description: 'A stored `transfer.verify` observation of this withdrawal that matches its identity, recent enough (the executor refuses stale evidence).',
      },
      ...(lateFact
        ? {
            valueTime: {
              ...instant,
              description: 'The approved open-period accounting date (ISO-8601 with an offset, at most millisecond precision): the original time is in a locked period.',
            },
          }
        : {}),
    },
    undefined,
    { description },
  );

/** Request payload per action, as accepted by `POST /admin/approvals`. */
export const ACTION_PAYLOAD_SCHEMAS: Readonly<Record<ApprovalActionType, SchemaObject>> = {
  [ApprovalActionType.CORRECTION]: {
    description: 'A compensating posting that fixes a break, by mode.',
    oneOf: [
      correctionVariant(CorrectionMode.CLEARING_TO_USER, 'A settlement line in CLEARING whose payer was identified: credit that user.', {
        userId: { ...uuid, description: 'The user to credit.' },
      }),
      correctionVariant(CorrectionMode.SETTLE_DEPOSIT_FROM_CLEARING, 'A CLEARING line that is really one of our deposits (amount mismatch, settled before it posted).'),
      correctionVariant(CorrectionMode.CLEARING_TO_PSP_PAYABLE, 'A CLEARING line we owe back to the PSP (duplicate, unknown or foreign-currency line).'),
      correctionVariant(CorrectionMode.PARTIAL_CHARGEBACK, 'A parked partial chargeback: debit the user for the disputed amount.'),
    ],
  },
  [ApprovalActionType.WRITE_OFF]: strict(
    { userId: uuid, currency, amount: { ...minorUnits, description: `${minorUnits.description} At most the overdraft.` }, valueTime },
    undefined,
    { description: 'Write off (part of) an unrecoverable overdraft to `EXPENSE:WRITE_OFF`.' },
  ),
  [ApprovalActionType.RATE_OVERRIDE]: {
    description: 'Accept a fetch rejected only for a > 20% jump, or inject a manual rate (break-glass allowed for MANUAL_RATE only).',
    oneOf: [
      strict({ mode: { type: 'string', enum: [RateOverrideMode.ACCEPT_REJECTED_SNAPSHOT] }, snapshotId: { ...uuid, description: 'The latest fetch, rejected only by the jump rule.' } }),
      strict({
        mode: { type: 'string', enum: [RateOverrideMode.MANUAL_RATE] },
        rates: {
          type: 'object',
          minProperties: 1,
          additionalProperties: rate,
          description: 'USD-based mid per ISO 4217 code (keys `^[A-Z]{3}$`): every active currency, USD = 1, each within its bounds.',
        },
        validForSeconds: {
          type: 'integer',
          minimum: 60,
          maximum: 86400,
          description: 'Accepted 60–86,400 by the schema; refused at request above 3,600 (above 900 by break-glass) with `409 ACTION_PRECONDITION_FAILED`.',
        },
      }),
    ],
  },
  [ApprovalActionType.SPREAD_CHANGE]: strict(
    {
      sourceCurrency: currency,
      targetCurrency: { ...currency, description: 'ISO 4217 code; must differ from `sourceCurrency`.' },
      spreadBasisPoints: { type: 'integer', minimum: 0, maximum: 9999, description: 'The new spread in basis points.' },
      minimumSourceAmount: { ...minorUnits, description: `The new minimum source amount. ${minorUnits.description}` },
    },
    ['sourceCurrency', 'targetCurrency'],
    { minProperties: 3, description: 'A directional pair\'s spread and/or minimum: give at least one of `spreadBasisPoints`, `minimumSourceAmount`.' },
  ),
  [ApprovalActionType.SUSPEND_USER]: strict({ userId: uuid }, undefined, { description: 'Suspend a user (break-glass allowed). Revokes every session.' }),
  [ApprovalActionType.REINSTATE_USER]: strict({ userId: uuid }, undefined, { description: 'Reinstate a suspended user.' }),
  [ApprovalActionType.CLOSE_PERIOD]: strict({ month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'A UTC calendar month, `YYYY-MM`.' } }, undefined, {
    description: 'Lock a reporting month. Stored (and returned) canonically with its half-open bounds `periodStart` / `periodEnd`.',
  }),
  [ApprovalActionType.ROLE_CHANGE]: strict(
    { userId: uuid, role: { type: 'string', enum: ['ADMIN', 'SECURITY'] }, operation: { type: 'string', enum: Object.values(RoleChangeOperation) } },
    undefined,
    { description: 'Grant or revoke ADMIN / SECURITY. Decided by a SECURITY officer.' },
  ),
  [ApprovalActionType.RESOLVE_BREAK]: strict({ breakId: uuid }, undefined, { description: 'Close a break with a documented operator decision (no money moves).' }),
  [ApprovalActionType.PAYSTACK_WITHDRAWAL_RECOVERY]: {
    description:
      'Apply a stored, matched Paystack transfer outcome to a withdrawal (database only: never sends a transfer). Refused when the break is not live, the evidence is stale, foreign or does not match, the flow is being processed, or the period is closed.',
    oneOf: [
      recoveryVariant(WithdrawalRecoveryMode.COMPLETE_MATCHED_SUCCESS, 'A matched verified success: complete an unresolved withdrawal, or a FAILED one\'s late success.', false),
      recoveryVariant(WithdrawalRecoveryMode.APPLY_MATCHED_FULL_RETURN, 'A matched full return of a POSTED withdrawal.', false),
      recoveryVariant(WithdrawalRecoveryMode.LATE_FACT_POST, 'A matched success whose own time is in a locked period, booked at the approved value time.', true),
      recoveryVariant(WithdrawalRecoveryMode.LATE_FACT_RETURN, 'A matched full return whose own time is in a locked period, booked at the approved value time.', true),
    ],
  },
};

/** The stored (canonical) CLOSE_PERIOD payload: `{month}` plus its derived bounds. */
export const STORED_CLOSE_PERIOD_PAYLOAD_SCHEMA: SchemaObject = strict(
  {
    month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    periodStart: { type: 'string', format: 'date-time', description: 'Inclusive.' },
    periodEnd: { type: 'string', format: 'date-time', description: 'Exclusive.' },
  },
  undefined,
  { description: 'CLOSE_PERIOD as stored: the requested month and its half-open UTC bounds.' },
);

/** Actions with a break-glass path (for some payload) — equal to `ACTION_POLICIES` (tested). */
export const BREAK_GLASS_ACTIONS: readonly ApprovalActionType[] = [ApprovalActionType.RATE_OVERRIDE, ApprovalActionType.SUSPEND_USER];

/** Component names: `{Action}Payload` in PascalCase (e.g. `WriteOffPayload`). */
export function payloadSchemaName(actionType: ApprovalActionType): string {
  return `${actionType.toLowerCase().replace(/(^|_)([a-z])/g, (_match, _separator, letter: string) => letter.toUpperCase())}Payload`;
}

export function approvalRequestSchemaName(actionType: ApprovalActionType): string {
  return payloadSchemaName(actionType).replace(/Payload$/, 'ApprovalRequest');
}

/** One whole-body variant of `POST /admin/approvals` per action: OpenAPI cannot discriminate a payload by a sibling field. */
export function approvalRequestSchema(actionType: ApprovalActionType): SchemaObject {
  const allowsBreakGlass = BREAK_GLASS_ACTIONS.includes(actionType);
  return strict(
    {
      actionType: { type: 'string', enum: [actionType] },
      payload: { $ref: `#/components/schemas/${payloadSchemaName(actionType)}` } as SchemaObject,
      reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Why: kept on the audit trail.' },
      breakGlass: {
        type: 'boolean',
        description: allowsBreakGlass
          ? 'Single-actor emergency path: executes in this request, pages security, reviewed within 24h.' +
            (actionType === ApprovalActionType.RATE_OVERRIDE ? ' MANUAL_RATE only.' : '')
          : 'Not allowed for this action: `true` is `403 BREAK_GLASS_NOT_ALLOWED`.',
      },
    },
    ['actionType', 'payload', 'reason'],
  );
}

/** Every component this module contributes to the document. */
export function actionPayloadComponents(): Record<string, SchemaObject> {
  const components: Record<string, SchemaObject> = { StoredClosePeriodPayload: STORED_CLOSE_PERIOD_PAYLOAD_SCHEMA };
  for (const actionType of Object.values(ApprovalActionType)) {
    components[payloadSchemaName(actionType)] = ACTION_PAYLOAD_SCHEMAS[actionType];
    components[approvalRequestSchemaName(actionType)] = approvalRequestSchema(actionType);
  }
  return components;
}

/** Documented request examples (each must pass the DTO, `parseActionPayload` and the schema — tested). */
export const APPROVAL_REQUEST_EXAMPLES: Readonly<Record<string, { summary: string; value: Record<string, unknown> }>> = {
  correctionClearingToUser: {
    summary: 'CORRECTION: credit an identified payer from CLEARING',
    value: {
      actionType: 'CORRECTION',
      payload: {
        mode: 'CLEARING_TO_USER',
        breakId: '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b',
        userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d',
        valueTime: '2026-09-28T12:00:00Z',
      },
      reason: 'Payer identified from the bank narration (ticket OPS-1042).',
    },
  },
  writeOff: {
    summary: 'WRITE_OFF: part of an overdraft',
    value: {
      actionType: 'WRITE_OFF',
      payload: { userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', currency: 'NGN', amount: '250000', valueTime: '2026-09-29T09:00:00+01:00' },
      reason: 'Chargeback overdraft unrecoverable after 90 days.',
    },
  },
  manualRateBreakGlass: {
    summary: 'RATE_OVERRIDE (MANUAL_RATE) by break-glass',
    value: {
      actionType: 'RATE_OVERRIDE',
      payload: { mode: 'MANUAL_RATE', rates: { USD: '1', NGN: '1530.25', EUR: '0.9212', GBP: '0.7841' }, validForSeconds: 900 },
      reason: 'Provider down during market hours; rates from the treasury desk.',
      breakGlass: true,
    },
  },
  acceptRejectedSnapshot: {
    summary: 'RATE_OVERRIDE: accept a genuine > 20% move',
    value: {
      actionType: 'RATE_OVERRIDE',
      payload: { mode: 'ACCEPT_REJECTED_SNAPSHOT', snapshotId: '5e4d3c2b-1a09-4f8e-a7d6-c5b4a3928170' },
      reason: 'Devaluation confirmed by two independent sources.',
    },
  },
  spreadChange: {
    summary: 'SPREAD_CHANGE',
    value: { actionType: 'SPREAD_CHANGE', payload: { sourceCurrency: 'NGN', targetCurrency: 'USD', spreadBasisPoints: 175 }, reason: 'Volatility review, week 39.' },
  },
  suspendUser: {
    summary: 'SUSPEND_USER',
    value: { actionType: 'SUSPEND_USER', payload: { userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d' }, reason: 'Account takeover suspected.' },
  },
  closePeriod: {
    summary: 'CLOSE_PERIOD',
    value: { actionType: 'CLOSE_PERIOD', payload: { month: '2026-08' }, reason: 'August books reconciled clean.' },
  },
  roleChange: {
    summary: 'ROLE_CHANGE (decided by SECURITY)',
    value: {
      actionType: 'ROLE_CHANGE',
      payload: { userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', role: 'ADMIN', operation: 'GRANT' },
      reason: 'New operations hire.',
    },
  },
  withdrawalRecovery: {
    summary: 'PAYSTACK_WITHDRAWAL_RECOVERY: a FAILED withdrawal\'s late success',
    value: {
      actionType: 'PAYSTACK_WITHDRAWAL_RECOVERY',
      payload: {
        mode: 'COMPLETE_MATCHED_SUCCESS',
        withdrawalId: '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a',
        breakId: '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b',
        observationId: '7d6c5b4a-3928-4170-8e6d-5c4b3a291807',
      },
      reason: 'Paystack verify shows the transfer succeeded after we recorded its failure (ticket OPS-2210).',
    },
  },
  resolveBreak: {
    summary: 'RESOLVE_BREAK',
    value: { actionType: 'RESOLVE_BREAK', payload: { breakId: '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b' }, reason: 'Duplicate detection of a resolved incident.' },
  },
};
