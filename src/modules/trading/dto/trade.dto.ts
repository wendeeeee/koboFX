import { ApiSchema } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { ApiUuid } from '../../../openapi/properties';

/**
 * `POST /wallet/trade` — execute a previously issued quote (design §7.7). The quote carries
 * every amount; nothing else is accepted ("buy $50 with NGN" is a TARGET-mode quote).
 */
@ApiSchema({ name: 'TradeRequest' })
export class TradeDto {
  @ApiUuid('An OPEN quote of yours (version-4 UUID), executed with its locked amounts.', '7d6c5b4a-3928-4170-8e5d-4c3b2a190807')
  @IsUUID('4', { message: 'quoteId must be a UUID' })
  quoteId!: string;
}
