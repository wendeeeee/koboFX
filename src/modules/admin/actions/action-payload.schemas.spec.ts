import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { ZodDiscriminatedUnion, ZodEffects, ZodObject, ZodOptional, ZodTypeAny } from 'zod';
import { ApprovalActionType } from '../approvals/approval.types';
import {
  ACTION_PAYLOAD_SCHEMAS,
  APPROVAL_REQUEST_EXAMPLES,
  BREAK_GLASS_ACTIONS,
  STORED_CLOSE_PERIOD_PAYLOAD_SCHEMA,
  actionPayloadComponents,
  approvalRequestSchemaName,
  payloadSchemaName,
} from './action-payload.schemas';
import { ACTION_PAYLOAD_SCHEMAS as ZOD_SCHEMAS, parseActionPayload } from './action-payloads';
import { ACTION_POLICIES } from './action-registry';

/**
 * The hand-written OpenAPI payload schemas (Phase 11 plan §E) against the Zod schemas that ARE the validation: same
 * variants, same properties, same required set, both strict; every documented example accepted by both; typical
 * mistakes refused by both.
 */
type Json = Record<string, unknown>;

/** The object shapes behind a Zod schema: unwraps refinements/transforms, expands discriminated unions in order. */
function zodObjects(schema: ZodTypeAny): ZodObject<Record<string, ZodTypeAny>>[] {
  if (schema instanceof ZodEffects) return zodObjects(schema.innerType());
  if (schema instanceof ZodDiscriminatedUnion) return (schema.options as ZodTypeAny[]).flatMap(zodObjects);
  if (schema instanceof ZodObject) return [schema as ZodObject<Record<string, ZodTypeAny>>];
  throw new Error(`Unexpected Zod schema ${schema.constructor.name}`);
}

/** The object variants of a JSON schema, in order. */
function jsonObjects(schema: Json): Json[] {
  return Array.isArray(schema.oneOf) ? (schema.oneOf as Json[]) : [schema];
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const components = actionPayloadComponents();
const toAjv = (node: unknown): unknown =>
  JSON.parse(JSON.stringify(node).replaceAll('#/components/schemas/', 'components#/schemas/'));
ajv.addSchema({ $id: 'components', schemas: toAjv(components) });
const validatorFor = (name: string) => ajv.compile({ $ref: `components#/schemas/${name}` });

describe('admin action payload schemas (OpenAPI ⇄ Zod)', () => {
  it.each(Object.values(ApprovalActionType))('%s: same variants, properties, required set; strict on both sides', (actionType) => {
    const zod = zodObjects(ZOD_SCHEMAS[actionType] as ZodTypeAny);
    const json = jsonObjects(ACTION_PAYLOAD_SCHEMAS[actionType] as Json);
    expect(json).toHaveLength(zod.length);
    zod.forEach((object, index) => {
      const variant = json[index] as Json;
      const shape = object.shape;
      expect(Object.keys(variant.properties as Json).sort()).toEqual(Object.keys(shape).sort());
      const required = Object.keys(shape).filter((key) => !((shape[key] as ZodTypeAny) instanceof ZodOptional));
      expect([...(variant.required as string[])].sort()).toEqual(required.sort());
      expect(object._def.unknownKeys).toBe('strict');
      expect(variant.additionalProperties).toBe(false);
    });
  });

  it('every documented approval example passes the DTO-level shape, parseActionPayload and the documented schema', () => {
    expect(Object.keys(APPROVAL_REQUEST_EXAMPLES).length).toBeGreaterThanOrEqual(Object.values(ApprovalActionType).length - 1);
    const seen = new Set<string>();
    for (const [name, { value }] of Object.entries(APPROVAL_REQUEST_EXAMPLES)) {
      const actionType = value.actionType as ApprovalActionType;
      seen.add(actionType);
      expect(() => parseActionPayload(actionType, value.payload)).not.toThrow();
      const validate = validatorFor(approvalRequestSchemaName(actionType));
      expect({ name, valid: validate(value), errors: validate.errors }).toEqual({ name, valid: true, errors: null });
    }
    // Every action has an example except REINSTATE_USER (the same shape as SUSPEND_USER).
    expect([...seen].sort()).toEqual(Object.values(ApprovalActionType).filter((type) => type !== ApprovalActionType.REINSTATE_USER).sort());
  });

  it('typical mistakes are refused by BOTH: an unknown field, a numeric amount, a missing field', () => {
    const cases: [ApprovalActionType, unknown][] = [
      [ApprovalActionType.WRITE_OFF, { userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', currency: 'NGN', amount: 250000, valueTime: '2026-09-29T09:00:00Z' }],
      [ApprovalActionType.WRITE_OFF, { userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', currency: 'NGN', amount: '250000' }],
      [ApprovalActionType.SUSPEND_USER, { userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', note: 'x' }],
      [ApprovalActionType.CORRECTION, { mode: 'CLEARING_TO_USER', breakId: '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b', valueTime: '2026-09-28T12:00:00Z' }],
      [ApprovalActionType.CORRECTION, { mode: 'PARTIAL_CHARGEBACK', breakId: '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b', userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', valueTime: '2026-09-28T12:00:00Z' }],
      [ApprovalActionType.RATE_OVERRIDE, { mode: 'MANUAL_RATE', rates: { NGN: 1530 }, validForSeconds: 900 }],
      [ApprovalActionType.RATE_OVERRIDE, { mode: 'MANUAL_RATE', rates: {}, validForSeconds: 900 }],
      [ApprovalActionType.RATE_OVERRIDE, { mode: 'MANUAL_RATE', rates: { NGN: '1530' }, validForSeconds: 30 }],
      [ApprovalActionType.SPREAD_CHANGE, { sourceCurrency: 'NGN', targetCurrency: 'USD' }],
      [ApprovalActionType.SPREAD_CHANGE, { sourceCurrency: 'NGN', targetCurrency: 'USD', spreadBasisPoints: 10_000 }],
      [ApprovalActionType.CLOSE_PERIOD, { month: '2026-13' }],
      [ApprovalActionType.ROLE_CHANGE, { userId: '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d', role: 'USER', operation: 'GRANT' }],
    ];
    for (const [actionType, payload] of cases) {
      expect(() => parseActionPayload(actionType, payload)).toThrow();
      const validate = validatorFor(payloadSchemaName(actionType));
      expect({ actionType, payload, documentedAccepts: validate(payload) }).toEqual({ actionType, payload, documentedAccepts: false });
    }
  });

  it('the stored CLOSE_PERIOD form documented for responses is what parseActionPayload stores', () => {
    const stored = parseActionPayload(ApprovalActionType.CLOSE_PERIOD, { month: '2026-08' });
    const validate = ajv.compile(toAjv(STORED_CLOSE_PERIOD_PAYLOAD_SCHEMA) as Json);
    expect(validate(stored)).toBe(true);
    expect(Object.keys(stored).sort()).toEqual(Object.keys(STORED_CLOSE_PERIOD_PAYLOAD_SCHEMA.properties as Json).sort());
  });

  it('the documented break-glass subset is ACTION_POLICIES\' (for some payload)', () => {
    const allows = (actionType: ApprovalActionType) =>
      Object.values(APPROVAL_REQUEST_EXAMPLES)
        .filter(({ value }) => value.actionType === actionType)
        .some(({ value }) => ACTION_POLICIES[actionType].breakGlassAllowed(parseActionPayload(actionType, value.payload)));
    const withExamples = Object.values(ApprovalActionType).filter((type) => type !== ApprovalActionType.REINSTATE_USER);
    expect(withExamples.filter(allows).sort()).toEqual([...BREAK_GLASS_ACTIONS].sort());
    expect(ACTION_POLICIES[ApprovalActionType.REINSTATE_USER].breakGlassAllowed({ userId: 'x' })).toBe(false);
  });
});
