import { ErrorCode } from '../../common/errors';
import { parseTransactionLookup } from './reference';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe(':reference shape', () => {
  it.each([
    [`funding:${ID}`, { kind: 'reference', reference: `funding:${ID}`, prefix: 'funding', id: ID }],
    [`demo-credit:${ID}`, { kind: 'reference', reference: `demo-credit:${ID}`, prefix: 'demo-credit', id: ID }],
    [`chargeback:${ID.toUpperCase()}`, { kind: 'reference', reference: `chargeback:${ID}`, prefix: 'chargeback', id: ID }],
    [`correction:${ID}`, { kind: 'reference', reference: `correction:${ID}`, prefix: 'correction', id: ID }],
    [ID, { kind: 'id', id: ID }],
    [ID.toUpperCase(), { kind: 'id', id: ID }],
  ])('accepts %s', (raw, expected) => {
    expect(parseTransactionLookup(raw)).toEqual(expected);
  });

  it.each([
    '',
    'funding',
    'funding:',
    `Funding:${ID}`,
    `-funding:${ID}`,
    `funding:${ID}x`,
    `funding:${ID}:x`,
    `funding ${ID}`,
    `${'a'.repeat(32)}:${ID}`,
    `funding:${ID.replace(/-/g, '')}`,
    "funding:1' OR '1'='1",
    `1funding:${ID}`,
  ])('refuses %j before any query', (raw) => {
    expect(() => parseTransactionLookup(raw)).toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }));
  });

  it('accepts a prefix of up to 31 characters', () => {
    expect(parseTransactionLookup(`${'a'.repeat(31)}:${ID}`).kind).toBe('reference');
  });
});
