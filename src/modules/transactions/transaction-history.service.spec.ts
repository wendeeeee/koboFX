import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ErrorCode } from '../../common/errors';
import { CurrencyRegistry } from '../currencies/currency-registry';
import { ListTransactionsQuery } from './dto/list-transactions.query';
import { HistorySort, decodeCursor } from './history-cursor';
import { TransactionHistoryRepository } from './transaction-history.repository';
import { DEFAULT_HISTORY_LIMIT, TransactionHistoryService } from './transaction-history.service';
import { HistoryRow } from './transaction.view';

const SCOPE = { userId: 'c0000000-0000-4000-8000-000000000001' };

function fundingRow(index: number): HistoryRow {
  return {
    source: 'TRANSACTION',
    id: `a0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    position_microseconds: String(1_790_000_000_000_000 - index),
    reference: `funding:${index}`,
    type: 'FUNDING',
    status: 'POSTED',
    reason_code: 'CARD_DEPOSIT',
    initiated_by: 'user:x',
    failure_code: null,
    value_time: new Date('2026-09-29T10:00:00Z'),
    booking_time: new Date('2026-09-29T10:00:00Z'),
    settlement_time: null,
    rate_display: null,
    reference_rate: null,
    rate_provider: null,
    rate_fetched_at: null,
    rate_provider_updated_at: null,
    rate_snapshot_id: null,
    spread_basis_points: null,
    quote_id: null,
    corrects_transaction_id: null,
    corrected_by_transaction_id: null,
    corrects_reference: null,
    corrects_type: null,
    corrected_by_reference: null,
    corrected_by_type: null,
    legs: [{ currency: 'NGN', minorUnit: 2, direction: 'CREDIT', amount: '100', balanceAfter: '100' }],
    requested_currency: null,
    requested_minor_unit: null,
    requested_amount: null,
  };
}

function setup(rows: HistoryRow[] = []) {
  const repository = { page: jest.fn().mockResolvedValue(rows), find: jest.fn().mockResolvedValue(null) };
  const known = new Map([
    ['NGN', { code: 'NGN', isActive: true }],
    ['ZWL', { code: 'ZWL', isActive: false }],
  ]);
  const currencies = { lookup: (code: string) => known.get(code) };
  const service = new TransactionHistoryService(repository as unknown as TransactionHistoryRepository, currencies as unknown as CurrencyRegistry);
  return { service, repository };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return (error as { code: ErrorCode }).code;
  }
};

describe('TransactionHistoryService', () => {
  it('asks for one row beyond the page, returns the page, and mints a cursor from its LAST row', async () => {
    const rows = [1, 2, 3].map(fundingRow);
    const { service, repository } = setup(rows);
    const page = await service.list(SCOPE, { limit: '2' });
    expect(repository.page).toHaveBeenCalledWith({ ...SCOPE, view: 'USER' }, expect.objectContaining({ sort: HistorySort.VALUE_TIME }), null, 3);
    expect(page.items.map((item) => item.reference)).toEqual(['funding:1', 'funding:2']);
    const query = repository.page.mock.calls[0][1];
    expect(decodeCursor(page.nextCursor!, query)).toEqual({ timeMicroseconds: BigInt(rows[1].position_microseconds), id: rows[1].id });
  });

  it('no next page ⇒ nextCursor null; default limit 50', async () => {
    const { service, repository } = setup([fundingRow(1)]);
    const page = await service.list(SCOPE, {});
    expect(page.nextCursor).toBeNull();
    expect(repository.page).toHaveBeenCalledWith({ ...SCOPE, view: 'USER' }, expect.anything(), null, DEFAULT_HISTORY_LIMIT + 1);
  });

  it('passes the decoded position, and the normalised query (sort, type, currency, µs bounds)', async () => {
    const { service, repository } = setup([fundingRow(1), fundingRow(2)]);
    const first = await service.list(SCOPE, { limit: '1', sort: 'bookingTime', type: 'FUNDING', currency: 'NGN', from: '2026-01-01T00:00:00.000001Z', to: '2026-12-31T00:00:00Z' });
    await service.list(SCOPE, { limit: '1', sort: 'bookingTime', type: 'FUNDING', currency: 'NGN', from: '2026-01-01T00:00:00.000001Z', to: '2026-12-31T00:00:00Z', cursor: first.nextCursor! });
    const [query, position] = repository.page.mock.calls[1].slice(1, 3);
    expect(query).toEqual({
      sort: HistorySort.BOOKING_TIME,
      type: 'FUNDING',
      currency: 'NGN',
      fromMicroseconds: BigInt(Date.UTC(2026, 0, 1)) * 1000n + 1n,
      toMicroseconds: BigInt(Date.UTC(2026, 11, 31)) * 1000n,
    });
    expect(position).toEqual({ timeMicroseconds: 1_789_999_999_999_999n, id: fundingRow(1).id });
  });

  it('refuses limits out of range, from ≥ to, unknown currencies; accepts an inactive but known one', async () => {
    const { service } = setup();
    for (const limit of ['0', '101', 'x', '1e2']) expect(await codeOf(service.list(SCOPE, { limit }))).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await codeOf(service.list(SCOPE, { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }))).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await codeOf(service.list(SCOPE, { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }))).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await codeOf(service.list(SCOPE, { from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00.000001Z' }))).toBe('resolved');
    expect(await codeOf(service.list(SCOPE, { currency: 'XYZ' }))).toBe(ErrorCode.UNSUPPORTED_CURRENCY);
    expect(await codeOf(service.list(SCOPE, { currency: 'ZWL' }))).toBe('resolved');
    expect(await codeOf(service.list(SCOPE, { cursor: 'garbage!' }))).toBe(ErrorCode.INVALID_CURSOR);
  });

  it('find: malformed ⇒ 400 before any query; absent ⇒ TRANSACTION_NOT_FOUND', async () => {
    const { service, repository } = setup();
    expect(await codeOf(service.find(SCOPE, 'nope'))).toBe(ErrorCode.VALIDATION_FAILED);
    expect(repository.find).not.toHaveBeenCalled();
    expect(await codeOf(service.find(SCOPE, 'funding:0f8fad5b-d9cb-469f-a165-70867728950e'))).toBe(ErrorCode.TRANSACTION_NOT_FOUND);
    repository.find.mockResolvedValueOnce(fundingRow(1));
    expect((await service.find(SCOPE, 'funding:0f8fad5b-d9cb-469f-a165-70867728950e')).reference).toBe('funding:1');
  });
});

describe('ListTransactionsQuery', () => {
  const violations = (input: Record<string, unknown>) =>
    validateSync(plainToInstance(ListTransactionsQuery, input), { whitelist: true, forbidNonWhitelisted: true }).map((error) => error.property);

  it('accepts the documented parameters', () => {
    expect(
      violations({ cursor: 'abc', limit: '100', type: 'CONVERSION', currency: 'USD', from: '2026-09-29T10:00:00.123456+01:00', to: '2026-09-30T10:00:00Z', sort: 'bookingTime' }),
    ).toEqual([]);
    expect(violations({ limit: '1' })).toEqual([]);
  });

  it.each([
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ limit: '01' }, 'limit'],
    [{ limit: '1.5' }, 'limit'],
    [{ limit: '-1' }, 'limit'],
    [{ type: 'SETTLEMENT' }, 'type'],
    [{ type: 'funding' }, 'type'],
    [{ currency: 'usd' }, 'currency'],
    [{ currency: 'USDT' }, 'currency'],
    [{ from: '2026-09-29' }, 'from'],
    [{ to: '2026-09-29T10:00:00.1234567Z' }, 'to'],
    [{ sort: 'VALUE_TIME' }, 'sort'],
    [{ cursor: 'x'.repeat(257) }, 'cursor'],
    [{ offset: '5' }, 'offset'],
  ])('refuses %j', (input, property) => {
    expect(violations(input)).toContain(property);
  });
});
