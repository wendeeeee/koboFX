import { INestApplication, RequestMethod } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type {
  HeaderObject,
  OperationObject,
  ParameterObject,
  ReferenceObject,
  ResponseObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { ErrorCode } from '../common/errors';
import { GLOBAL_RATE_LIMIT_RULE } from '../common/guards/rate-limit.guard';
import { IDEMPOTENCY_KEY_PATTERN } from '../common/interceptors/idempotency/idempotency-decision';
import { actionPayloadComponents } from '../modules/admin/actions/action-payload.schemas';
import { ERROR_CODE_DESCRIPTIONS, ERROR_CODE_HTTP_STATUS, TRANSIENT_ERROR_CODES } from './error-codes.openapi';
import { ErrorResponse, errorExample } from './error-response.openapi';
import { RouteDescriptor, collectRoutes } from './route-metadata';

export const BEARER_SCHEME = 'bearer';
export const PSP_SIGNATURE_SCHEME = 'pspSignature';
export const IDEMPOTENCY_KEY_PARAMETER = 'IdempotencyKey';

/** One tag per module (Phase 11 plan §B). */
export const API_TAGS = {
  auth: 'Registration, email verification, sessions. No `Idempotency-Key` here: each route is safe to retry by its own semantics (a recorded deviation from design §12).',
  users: 'The caller\'s own profile.',
  wallet: 'Balances (total, reserved, available) and card funding through the PSP.',
  fx: 'Exchange rates (display only) and 30-second single-use quotes.',
  trading: 'Market conversions and quoted trades. Both post one ledger transaction and answer the same body.',
  transactions: 'Keyset-paginated history of the caller\'s own transactions (and fundings that never posted).',
  webhooks: 'Machine-to-machine: the payment service provider\'s event hints. Not for API clients.',
  health: 'Liveness and readiness probes.',
  'admin-approvals': 'Four-eyes approvals for sensitive actions (and break-glass). ADMIN / SECURITY only.',
  'admin-reads': 'Operator read models: positions, reconciliation breaks and runs, users, recertification. ADMIN / SECURITY only.',
} as const;

export type ApiTag = keyof typeof API_TAGS;

const API_DESCRIPTION = `
The KoboFX FX trading API (v1). Conventions every client must follow:

- **Amounts are strings of minor units**, never JSON numbers: \`"150000"\` NGN is ₦1,500.00. The scale of a currency is
  its \`minorUnit\` (NGN 2, USD 2, JPY 0, KWD 3), returned next to every amount. Rates are display strings; the amounts
  are authoritative.
- **\`Idempotency-Key\` is required on every mutating money and admin route** (16–128 characters of \`[A-Za-z0-9_-]\`;
  one key per logical operation, reused on every retry of it). Keys never expire. A replay answers the stored response
  byte for byte with \`Idempotent-Replayed: true\`; the same key with a different body is \`409 IDEMPOTENCY_KEY_REUSE\`.
  Transient failures (\`503\`, \`500\`, \`429\`, \`409 REQUEST_IN_PROGRESS\`) store nothing: retry with the SAME key.
  \`/auth/*\` takes no key.
- **Errors** always have the \`ErrorResponse\` shape. Branch on \`code\` (stable, never renamed), never on \`message\`.
  Each operation lists only the codes it can raise. \`Retry-After\` accompanies \`429\`, \`503\` and
  \`409 REQUEST_IN_PROGRESS\`.
- **\`X-Correlation-Id\`**: send your own (8–128 characters of \`[A-Za-z0-9._:-]\`) or receive a generated UUID; it is on every
  response and in every error body.
- **Authentication**: \`Authorization: Bearer <access token>\` (RS256 JWT, short-lived: 15 minutes by default) on everything that is not marked
  public. Most routes also require an ACTIVE (verified, not suspended) user. Refresh tokens rotate strictly: a reused
  refresh token revokes the whole session family, so single-flight your refreshes.
- **Rate limits**: 100 requests per minute per IP on every route (except health), plus the per-route limits listed on
  each operation.
`.trim();

const correlationHeader: HeaderObject = {
  description: 'The request\'s correlation id (yours, or a generated UUID). Also in every error body.',
  schema: { type: 'string' },
};
const retryAfterHeader: HeaderObject = { description: 'Seconds to wait before retrying.', schema: { type: 'integer', minimum: 0 } };
const replayedHeader: HeaderObject = {
  description: 'Present (`true`) when this is the stored outcome of an earlier request with the same `Idempotency-Key`.',
  schema: { type: 'string', enum: ['true'] },
};

const METHODS: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

/** The codes the request pipeline (not the route's own logic) can answer with, from the route's real metadata. */
export function pipelineErrorCodes(route: RouteDescriptor): ErrorCode[] {
  const codes: ErrorCode[] = [ErrorCode.INTERNAL_ERROR, ErrorCode.INVARIANT_VIOLATION];
  if (route.skipRateLimit) return codes; // health: no guards that can refuse, no database error it does not catch
  codes.push(ErrorCode.RATE_LIMITED, ErrorCode.RESOURCE_BUSY);
  if (route.validatesInput) codes.push(ErrorCode.VALIDATION_FAILED);
  if (route.hasBody) codes.push(ErrorCode.PAYLOAD_TOO_LARGE);
  if (!route.isPublic) {
    codes.push(ErrorCode.UNAUTHENTICATED);
    if (!route.allowUnverified) codes.push(ErrorCode.EMAIL_NOT_VERIFIED, ErrorCode.ACCOUNT_SUSPENDED);
    if (route.roles.length > 0) codes.push(ErrorCode.FORBIDDEN);
  }
  if (route.idempotent) {
    codes.push(
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      ErrorCode.IDEMPOTENCY_KEY_INVALID,
      ErrorCode.IDEMPOTENCY_KEY_REUSE,
      ErrorCode.REQUEST_IN_PROGRESS,
    );
  }
  if (route.rateLimit?.whenUnavailable === 'fail-closed') codes.push(ErrorCode.DEPENDENCY_UNAVAILABLE);
  return codes;
}

/** Every code a route documents: its own (`@ApiErrors`) and the pipeline's, de-duplicated, in enum order. */
export function documentedErrorCodes(route: RouteDescriptor): ErrorCode[] {
  const all = new Set<ErrorCode>([...route.errors, ...pipelineErrorCodes(route)]);
  return (Object.values(ErrorCode) as ErrorCode[]).filter((code) => all.has(code));
}

/** Raised inside the idempotency barrier and permanent: the route's own codes (and its pipes' validation), below 500. */
function storedRefusal(route: RouteDescriptor, code: ErrorCode): boolean {
  const status = ERROR_CODE_HTTP_STATUS[code];
  const inside = route.errors.includes(code) || (code === ErrorCode.VALIDATION_FAILED && route.validatesInput);
  return inside && status < 500 && !TRANSIENT_ERROR_CODES.includes(code);
}

function errorResponse(status: number, codes: readonly ErrorCode[], route: RouteDescriptor): ResponseObject {
  const headers: Record<string, HeaderObject> = { 'X-Correlation-Id': correlationHeader };
  if (status === 429 || status === 503 || codes.includes(ErrorCode.REQUEST_IN_PROGRESS)) headers['Retry-After'] = retryAfterHeader;
  // A permanent refusal raised INSIDE the barrier (the handler and its pipes) is stored and replayed for that key; the
  // guards, the key checks and the body parser refuse before it, and transient failures are never stored.
  if (route.idempotent && codes.some((code) => storedRefusal(route, code))) headers['Idempotent-Replayed'] = replayedHeader;
  const narrowed: SchemaObject = {
    type: 'object',
    properties: {
      statusCode: { type: 'integer', enum: [status] },
      code: { type: 'string', enum: [...codes] },
    },
  };
  return {
    description: codes.map((code) => `\`${code}\`: ${ERROR_CODE_DESCRIPTIONS[code]}`).join('\n\n'),
    headers,
    content: {
      'application/json': {
        schema: { allOf: [{ $ref: '#/components/schemas/ErrorResponse' }, narrowed] },
        examples: Object.fromEntries(codes.map((code) => [code, { value: errorExample(code) }])),
      },
    },
  };
}

function accessDescription(route: RouteDescriptor): string {
  const rules = [...(route.rateLimit?.replacesGlobalRule ? [] : route.skipRateLimit ? [] : [GLOBAL_RATE_LIMIT_RULE]), ...(route.rateLimit?.rules ?? [])];
  const lines: string[] = [];
  if (route.isPublic) lines.push('**Access:** public (no bearer token).');
  else if (route.allowUnverified) lines.push('**Access:** any authenticated session (the user need not be verified).');
  else lines.push('**Access:** an authenticated ACTIVE user (verified, not suspended).');
  if (route.roles.length > 0) lines.push(`**Roles:** ${route.roles.join(', ')}.`);
  if (route.idempotent) lines.push('**Idempotent:** requires `Idempotency-Key`; retries replay the stored outcome.');
  if (route.skipRateLimit) lines.push('**Rate limit:** none.');
  else {
    const described = rules.map((rule) => `${rule.limit} per ${rule.windowSeconds}s per ${rule.subject} (\`${rule.name}\`)`).join('; ');
    const mode = route.rateLimit?.whenUnavailable === 'fail-closed' ? ' Refused with `503` if the limiter is unavailable.' : '';
    lines.push(`**Rate limit:** ${described}.${mode}`);
  }
  return lines.join('\n\n');
}

function decorate(operation: OperationObject, route: RouteDescriptor): void {
  // Security: what JwtAuthGuard enforces. Public routes say so explicitly; the webhook keeps its signature scheme.
  if (route.isPublic) {
    operation.security = operation.security?.some((requirement) => PSP_SIGNATURE_SCHEME in requirement) ? operation.security : [];
  } else {
    operation.security = [{ [BEARER_SCHEME]: [] }];
  }

  const parameters = (operation.parameters ?? []) as (ParameterObject | ReferenceObject)[];
  if (route.idempotent) parameters.unshift({ $ref: `#/components/parameters/${IDEMPOTENCY_KEY_PARAMETER}` });
  operation.parameters = parameters;

  const extensions = operation as OperationObject & Record<string, unknown>;
  extensions['x-authentication'] = route.isPublic ? 'public' : route.allowUnverified ? 'any-session' : 'active-user';
  if (route.roles.length > 0) extensions['x-roles'] = [...route.roles];
  extensions['x-idempotent'] = route.idempotent !== undefined;
  extensions['x-rate-limits'] = route.skipRateLimit
    ? []
    : [...(route.rateLimit?.replacesGlobalRule ? [] : [GLOBAL_RATE_LIMIT_RULE]), ...(route.rateLimit?.rules ?? [])].map((rule) => ({ ...rule }));

  operation.description = [operation.description, accessDescription(route)].filter(Boolean).join('\n\n');

  // Success responses: the correlation header always; the replay marker on idempotent routes.
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (Number(status) >= 400) continue;
    const success = response as ResponseObject;
    success.headers = { 'X-Correlation-Id': correlationHeader, ...(route.idempotent ? { 'Idempotent-Replayed': replayedHeader } : {}), ...success.headers };
  }

  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of documentedErrorCodes(route)) {
    const status = ERROR_CODE_HTTP_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const [status, codes] of [...byStatus.entries()].sort(([a], [b]) => a - b)) {
    if (operation.responses[String(status)]) {
      throw new Error(`${route.operationId}: status ${status} is documented as a success and as an error.`);
    }
    operation.responses[String(status)] = errorResponse(status, codes, route);
  }
}

/**
 * OpenAPI 3.0 ignores every sibling of `$ref`, so `{ $ref, nullable: true }` (what `@ApiProperty({ type: Class,
 * nullable: true })` emits) would silently document "never null". Rewrite such nodes as `{ allOf: [{ $ref }], … }`.
 */
function normaliseReferenceSiblings(node: unknown): void {
  if (typeof node !== 'object' || node === null) return;
  if (Array.isArray(node)) return node.forEach(normaliseReferenceSiblings);
  const record = node as Record<string, unknown>;
  for (const value of Object.values(record)) normaliseReferenceSiblings(value);
  if (typeof record.$ref === 'string' && Object.keys(record).length > 1) {
    const reference = record.$ref;
    delete record.$ref;
    if (record.type === 'object') delete record.type; // the referenced schema says it
    record.allOf = [{ $ref: reference }];
  }
}

/**
 * The OpenAPI 3 document of the running application (Phase 11). Built from the controllers' decorators, then
 * completed from the SAME metadata the guard chain reads (public, roles, unverified, idempotent, rate limits), so
 * security, the `Idempotency-Key` parameter and the pipeline's error codes cannot drift from what the app does.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('KoboFX API')
    .setDescription(API_DESCRIPTION)
    .setVersion('1')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'The access token from `/auth/login`, `/auth/verify` or `/auth/refresh`.' }, BEARER_SCHEME)
    .addSecurity(PSP_SIGNATURE_SCHEME, {
      type: 'apiKey',
      in: 'header',
      name: 'X-Psp-Signature',
      description:
        '`t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "t." + raw body bytes)>`, at most 300 seconds old. Up to two secrets are accepted (rotation).',
    });
  for (const [name, description] of Object.entries(API_TAGS)) builder.addTag(name, description);

  const document = SwaggerModule.createDocument(app, builder.build(), { extraModels: [ErrorResponse] });

  const components = document.components ?? (document.components = {});
  components.schemas = { ...components.schemas, ...actionPayloadComponents() };
  components.parameters = {
    ...components.parameters,
    [IDEMPOTENCY_KEY_PARAMETER]: {
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description: 'One key per logical operation; reuse it on every retry. Never expires. Scoped to (you, this route).',
      schema: { type: 'string', pattern: IDEMPOTENCY_KEY_PATTERN.source, minLength: 16, maxLength: 128 },
      example: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
    },
  };
  const errorCodeSchema = components.schemas?.ErrorCode as SchemaObject | undefined;
  if (errorCodeSchema) {
    errorCodeSchema.description =
      'Stable error codes: clients branch on these. A code is never renamed or reused.\n\n' +
      (Object.values(ErrorCode) as ErrorCode[]).map((code) => `- \`${code}\` (${ERROR_CODE_HTTP_STATUS[code]}): ${ERROR_CODE_DESCRIPTIONS[code]}`).join('\n');
  }

  const operations = new Map<string, OperationObject>();
  for (const pathItem of Object.values(document.paths)) {
    for (const method of Object.values(METHODS)) {
      const operation = (pathItem as Record<string, OperationObject | undefined>)[method as string];
      if (operation?.operationId) operations.set(operation.operationId, operation);
    }
  }
  for (const route of collectRoutes(app)) {
    const operation = operations.get(route.operationId);
    if (!operation) throw new Error(`OpenAPI: no operation was generated for ${route.operationId}.`);
    decorate(operation, route);
  }
  normaliseReferenceSiblings(document.paths);
  normaliseReferenceSiblings(document.components);
  return document;
}
