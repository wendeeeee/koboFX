import { IsUUID } from 'class-validator';

/**
 * `POST /wallet/trade` — execute a previously issued quote (design §7.7). The quote carries
 * every amount; nothing else is accepted ("buy $50 with NGN" is a TARGET-mode quote).
 */
export class TradeDto {
  @IsUUID('4', { message: 'quoteId must be a UUID' })
  quoteId!: string;
}
