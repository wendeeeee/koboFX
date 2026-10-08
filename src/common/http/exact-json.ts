import { LosslessNumber, stringify } from 'lossless-json';
import { InvariantViolationError } from '../errors';
import { isInt64 } from '../money';

/** A JSON value whose integers are `bigint` — never a JavaScript number. */
export type ExactJsonValue = string | boolean | null | bigint | readonly ExactJsonValue[] | { readonly [key: string]: ExactJsonValue | undefined };

/**
 * Serialise a request body whose money is a JSON INTEGER (Paystack's Transfer API takes `amount` in subunits as an
 * integer — WITHDRAWAL_PLAN.md §H). Every `bigint` is written as its exact digits through `lossless-json`; a
 * JavaScript `number` is refused outright (it may already have lost digits), as is a `bigint` outside signed 64 bits.
 * `JSON.stringify` cannot do this (it throws on bigint, and a LosslessNumber would become an object).
 */
export function exactJsonBody(value: { readonly [key: string]: ExactJsonValue | undefined }): string {
  const text = stringify(convert(value, '$'));
  if (text === undefined) throw new InvariantViolationError('A request body serialised to nothing.');
  return text;
}

function convert(value: unknown, path: string): unknown {
  if (typeof value === 'bigint') {
    if (!isInt64(value)) throw new InvariantViolationError('A JSON integer must fit in signed 64 bits.', { path, value: value.toString() });
    return new LosslessNumber(value.toString());
  }
  if (typeof value === 'number') {
    throw new InvariantViolationError('A JavaScript number is not allowed in an exact JSON body; use bigint or a string.', { path });
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item, index) => convert(item, `${path}[${index}]`));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (inner !== undefined) result[key] = convert(inner, `${path}.${key}`);
    }
    return result;
  }
  throw new InvariantViolationError('Unsupported value in an exact JSON body.', { path, type: typeof value });
}
