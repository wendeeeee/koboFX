import { ValidationError } from '../../common/errors';


export type TransactionLookup =
  | { readonly kind: 'reference'; readonly reference: string; readonly prefix: string; readonly id: string }
  | { readonly kind: 'id'; readonly id: string };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PREFIXED_PATTERN = new RegExp(`^([a-z][a-z-]{0,30}):(${UUID})$`);
const BARE_PATTERN = new RegExp(`^(${UUID})$`);

export const TRANSACTION_REFERENCE_PATTERN = `^(([a-z][a-z-]{0,30}):)?${UUID}$`;

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
