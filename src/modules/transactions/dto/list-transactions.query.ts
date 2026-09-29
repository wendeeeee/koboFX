import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { HistorySort } from '../history-cursor';
import { HISTORY_TYPES } from '../history-status';

/** 1–100, digits only (no sign, no decimals, no exponent, no padding). */
const LIMIT_PATTERN = /^(100|[1-9]\d?)$/;
const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const INSTANT_MESSAGE = 'must be ISO-8601 with an offset and at most 6 fractional digits, e.g. 2026-09-29T10:00:00Z';

/**
 * `GET /transactions` (design §7.8). Query strings stay strings here; the service parses them
 * exactly (`limit` to a number, instants to epoch µs — never via a JS `Date`). Unknown parameters
 * are refused by the global pipe (`forbidNonWhitelisted`).
 */
export class ListTransactionsQuery {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @IsOptional()
  @IsString()
  @Matches(LIMIT_PATTERN, { message: 'limit must be a whole number from 1 to 100' })
  limit?: string;

  @IsOptional()
  @IsIn(HISTORY_TYPES, { message: `type must be one of ${HISTORY_TYPES.join(', ')}` })
  type?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency?: string;

  @IsOptional()
  @IsString()
  @Matches(INSTANT_SHAPE, { message: `from ${INSTANT_MESSAGE}` })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(INSTANT_SHAPE, { message: `to ${INSTANT_MESSAGE}` })
  to?: string;

  @IsOptional()
  @IsIn(Object.values(HistorySort), { message: `sort must be one of ${Object.values(HistorySort).join(', ')}` })
  sort?: string;
}
