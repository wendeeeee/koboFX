import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';

/** One currency of a wallet (design §12: total, reserved and available). Strings of minor units. */
export interface WalletBalance {
  readonly currency: string;
  readonly minorUnit: number;
  readonly total: string;
  readonly reserved: string;
  readonly available: string;
}

/**
 * The `GET /wallet` read model. Read-only: balances come from the ledger's cached
 * `balance_minor` / `reserved_minor` (both maintained under row locks), and
 * `available = total − reserved` is computed in SQL on BIGINTs — never a JS number.
 */
@Injectable()
export class WalletBalancesService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** Scoped by the caller in the WHERE clause. */
  async balancesOf(userId: string): Promise<WalletBalance[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT accounts.currency_code, currencies.minor_unit,
              accounts.balance_minor::text AS total, accounts.reserved_minor::text AS reserved,
              (accounts.balance_minor - accounts.reserved_minor)::text AS available
         FROM accounts
         JOIN wallets ON wallets.id = accounts.wallet_id
         JOIN currencies ON currencies.code = accounts.currency_code
        WHERE wallets.user_id = $1
        ORDER BY accounts.currency_code`,
      [userId],
    )) as { currency_code: string; minor_unit: number; total: string; reserved: string; available: string }[];
    return rows.map((row) => ({
      currency: row.currency_code,
      minorUnit: row.minor_unit,
      total: row.total,
      reserved: row.reserved,
      available: row.available,
    }));
  }
}
