import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { MAXIMUM_STASH_CURSOR_LENGTH } from '../stash-cursor';

const LIMIT_PATTERN = /^(100|[1-9]\d?)$/;

export class StashTransactionsQuery {
  @ApiPropertyOptional({ pattern: '^[A-Z]{3}$', example: 'NGN', description: 'Only receipts in this currency.' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency?: string;

  @ApiPropertyOptional({ maxLength: MAXIMUM_STASH_CURSOR_LENGTH, description: 'The previous page\'s `nextCursor`. Valid only with the same `currency`.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAXIMUM_STASH_CURSOR_LENGTH)
  cursor?: string;

  @ApiPropertyOptional({ type: 'string', pattern: LIMIT_PATTERN.source, example: '50', description: 'Page size, 1–100 (default 50). Digits only.' })
  @IsOptional()
  @IsString()
  @Matches(LIMIT_PATTERN, { message: 'limit must be a whole number from 1 to 100' })
  limit?: string;
}
