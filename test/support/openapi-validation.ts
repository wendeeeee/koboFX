import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Validate real HTTP bodies against the published OpenAPI document (Phase 11). OpenAPI 3.0 schemas are not quite JSON
 * Schema: `nullable` is translated, documentation-only keywords are dropped, and — in CLOSED mode — every object that
 * lists `properties` gets `additionalProperties: false` unless it says otherwise, so a documented field the code never
 * sends, or a sent field the document never mentions, fails. The published document itself stays open (clients must
 * tolerate additive fields); only this validator closes it.
 */
type Json = Record<string, unknown>;

const DROPPED = new Set(['example', 'examples', 'discriminator', 'xml', 'externalDocs', 'deprecated']);

function convert(node: unknown, closed: boolean, insideAllOf = false): unknown {
  if (Array.isArray(node)) return node.map((item) => convert(item, closed, insideAllOf));
  if (typeof node !== 'object' || node === null) return node;
  const source = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    if (DROPPED.has(key) || key.startsWith('x-') || key === 'nullable') continue;
    if (key === '$ref' && typeof value === 'string') {
      out.$ref = value.replace('#/components/schemas/', 'openapi#/components/schemas/');
      continue;
    }
    if (key === 'properties' || key === 'patternProperties') {
      out[key] = Object.fromEntries(Object.entries(value as Json).map(([name, schema]) => [name, convert(schema, closed)]));
      continue;
    }
    out[key] = convert(value, closed, key === 'allOf');
  }
  if (closed && !insideAllOf && out.properties !== undefined && out.additionalProperties === undefined) out.additionalProperties = false;
  if (source.nullable === true) {
    if (typeof out.type === 'string' && out.allOf === undefined && out.oneOf === undefined && out.anyOf === undefined) {
      out.type = [out.type, 'null'];
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    } else {
      return { anyOf: [out, { type: 'null' }] };
    }
  }
  return out;
}

export interface OperationMatch {
  readonly path: string;
  readonly method: string;
  readonly operation: Json;
}

/** `/api/v1/transactions/funding:abc` → the documented `/api/v1/transactions/{reference}`. */
export function matchOperation(document: OpenAPIObject, method: string, url: string): OperationMatch {
  const path = url.split('?')[0] as string;
  for (const [template, item] of Object.entries(document.paths)) {
    const pattern = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}$`);
    const operation = (item as Json)[method.toLowerCase()] as Json | undefined;
    if (operation && pattern.test(path)) return { path: template, method: method.toLowerCase(), operation };
  }
  throw new Error(`No documented operation for ${method} ${path}`);
}

export class OpenApiValidator {
  private readonly ajv: Ajv;
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(private readonly document: OpenAPIObject, closed = true) {
    this.ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(this.ajv);
    this.ajv.addSchema({ $id: 'openapi', components: { schemas: convert(document.components?.schemas ?? {}, closed) } });
    this.closed = closed;
  }

  private readonly closed: boolean;

  /** The documented schema of one response, compiled. */
  responseValidator(method: string, url: string, status: number): { validate: ValidateFunction; match: OperationMatch } {
    const match = matchOperation(this.document, method, url);
    const key = `${match.method} ${match.path} ${status}`;
    let validate = this.cache.get(key);
    if (!validate) {
      const responses = match.operation.responses as Record<string, Json>;
      const response = responses[String(status)];
      if (!response) throw new Error(`${key}: status ${status} is not documented (documented: ${Object.keys(responses).join(', ')})`);
      const schema = ((response.content as Json | undefined)?.['application/json'] as Json | undefined)?.schema;
      if (!schema) throw new Error(`${key}: no JSON schema documented`);
      validate = this.ajv.compile(convert(schema, this.closed) as Json);
      this.cache.set(key, validate);
    }
    return { validate, match };
  }

  /** Validate a schema-by-name (e.g. a request example against `WriteOffPayload`). */
  schemaValidator(name: string): ValidateFunction {
    return this.ajv.compile({ $ref: `openapi#/components/schemas/${name}` });
  }

  /** Validate an arbitrary OpenAPI schema object (refs resolve into the document). */
  compile(schema: unknown): ValidateFunction {
    return this.ajv.compile(convert(schema, this.closed) as Json);
  }

  /** Throws with every AJV error when `body` does not match the documented response. */
  assertResponse(method: string, url: string, status: number, body: unknown): void {
    const match = matchOperation(this.document, method, url);
    const response = (match.operation.responses as Record<string, Json>)[String(status)];
    if (response && response.content === undefined) {
      if (body !== undefined && body !== '' && !(typeof body === 'object' && body !== null && Object.keys(body).length === 0)) {
        throw new Error(`${method} ${url} → ${status} documents no body, but one was sent: ${JSON.stringify(body)}`);
      }
      return;
    }
    const { validate } = this.responseValidator(method, url, status);
    if (!validate(body)) {
      throw new Error(
        `${method} ${url} → ${status} does not match ${match.method.toUpperCase()} ${match.path}:\n` +
          JSON.stringify(validate.errors, null, 2) +
          `\nbody: ${JSON.stringify(body, null, 2)}`,
      );
    }
    if (status >= 400) {
      const documented = documentedCodes(match.operation, status);
      const code = (body as { code?: string }).code;
      if (!code || !documented.includes(code)) {
        throw new Error(`${method} ${url} → ${status} ${code}: not among the documented codes ${documented.join(', ')}`);
      }
    }
  }
}

/** The error codes an operation documents for one status (from the narrowed `code` enum). */
export function documentedCodes(operation: Json, status: number): string[] {
  const response = (operation.responses as Record<string, Json>)[String(status)];
  const schema = ((response?.content as Json | undefined)?.['application/json'] as Json | undefined)?.schema as Json | undefined;
  const narrowed = ((schema?.allOf as Json[] | undefined) ?? [])[1] as Json | undefined;
  return (((narrowed?.properties as Json | undefined)?.code as Json | undefined)?.enum as string[] | undefined) ?? [];
}
