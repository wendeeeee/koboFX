import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every depth: the same logical body always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The request hash (design §0.3 point 1): sha256 over the endpoint and the canonical
 * body, as lowercase hex. A reused key with a different body is refused (`409`) rather
 * than silently answered with a response to a different request.
 */
export function requestHash(endpoint: string, body: unknown): string {
  return createHash('sha256').update(endpoint).update('\n').update(canonicalJson(body)).digest('hex');
}
