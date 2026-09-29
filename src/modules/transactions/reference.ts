import { ValidationError } from '../../common/errors';

/**
 * `:reference` in `GET /transactions/:reference` (Phase 8 decision 10), checked before any query.
 *
 * - `prefix:{uuid}` — `funding:`, `conversion:`, `chargeback:`, `demo-credit:`, and any later
 *   prefix of the same shape (Phase 9/10 need no change here). Express has already decoded
 *   `%3A`, so the colon may come raw or encoded.
 * - a bare UUID — the transaction id (which is also the reference of a transaction posted
 *   without one).
 *
 * UUIDs are matched case-insensitively and looked up lowercase (as stored).
 */
export type TransactionLookup =
  | { readonly kind: 'reference'; readonly reference: string; readonly prefix: string; readonly id: string }
  | { readonly kind: 'id'; readonly id: string };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PREFIXED_PATTERN = new RegExp(`^([a-z][a-z-]{0,30}):(${UUID})$`);
const BARE_PATTERN = new RegExp(`^(${UUID})$`);

export function parseTransactionLookup(raw: string): TransactionLookup {
  const prefixed = PREFIXED_PATTERN.exec(raw);
  if (prefixed) {
    const id = prefixed[2].toLowerCase();
    return { kind: 'reference', reference: `${prefixed[1]}:${id}`, prefix: prefixed[1], id };
  }
  const bare = BARE_PATTERN.exec(raw);
  if (bare) return { kind: 'id', id: bare[1].toLowerCase() };
  throw new ValidationError('reference must be a transaction reference (e.g. conversion:{uuid}) or a transaction id.', {
    violations: ['reference must be a transaction reference (e.g. conversion:{uuid}) or a transaction id'],
  });
}
