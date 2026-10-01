import { ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiPropertyOptional({ maxLength: 256, description: 'The previous page\'s `nextCursor`. Valid only with the same sort and filters.' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @ApiPropertyOptional({ type: 'string', pattern: LIMIT_PATTERN.source, example: '50', description: 'Page size, 1–100 (default 50). Digits only.' })
  @IsOptional()
  @IsString()
  @Matches(LIMIT_PATTERN, { message: 'limit must be a whole number from 1 to 100' })
  limit?: string;

  @ApiPropertyOptional({ enum: HISTORY_TYPES, description: 'Only this transaction type.' })
  @IsOptional()
  @IsIn(HISTORY_TYPES, { message: `type must be one of ${HISTORY_TYPES.join(', ')}` })
  type?: string;

  @ApiPropertyOptional({ pattern: '^[A-Z]{3}$', example: 'NGN', description: 'Only transactions with one of YOUR legs in this currency.' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency?: string;

  @ApiPropertyOptional({ format: 'date-time', pattern: INSTANT_SHAPE.source, example: '2026-09-01T00:00:00Z', description: `Inclusive lower bound on the active sort's time; ${INSTANT_MESSAGE}.` })
  @IsOptional()
  @IsString()
  @Matches(INSTANT_SHAPE, { message: `from ${INSTANT_MESSAGE}` })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', pattern: INSTANT_SHAPE.source, example: '2026-10-01T00:00:00Z', description: `Exclusive upper bound on the active sort's time (after \`from\`); ${INSTANT_MESSAGE}.` })
  @IsOptional()
  @IsString()
  @Matches(INSTANT_SHAPE, { message: `to ${INSTANT_MESSAGE}` })
  to?: string;

  @ApiPropertyOptional({ enum: Object.values(HistorySort), default: HistorySort.VALUE_TIME, description: '`valueTime` (when it happened; default) or `bookingTime` (when we recorded it; for "never miss a row" consumers). Newest first.' })
  @IsOptional()
  @IsIn(Object.values(HistorySort), { message: `sort must be one of ${Object.values(HistorySort).join(', ')}` })
  sort?: string;
}
