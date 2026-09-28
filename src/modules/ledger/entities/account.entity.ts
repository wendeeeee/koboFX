import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer } from '../../../database/bigint.transformer';
import { AccountType, NormalSide } from '../ledger.types';

/**
 * Read model of `accounts` (design §5.2). Balances are a cached projection of the
 * ledger, written ONLY by `LedgerService.post()`; never save this entity to change one.
 */
@Entity('accounts')
export class AccountEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  code!: string;

  @Column({ name: 'account_type', type: 'enum', enum: AccountType, enumName: 'account_type' })
  accountType!: AccountType;

  @Column({ name: 'normal_side', type: 'enum', enum: NormalSide, enumName: 'normal_side' })
  normalSide!: NormalSide;

  @Column({ name: 'wallet_id', type: 'uuid', nullable: true })
  walletId!: string | null;

  @Column({ name: 'currency_code', type: 'char', length: 3 })
  currencyCode!: string;

  @Column({ name: 'balance_minor', type: 'bigint', transformer: bigintTransformer })
  balanceMinor!: bigint;

  @Column({ name: 'reserved_minor', type: 'bigint', transformer: bigintTransformer })
  reservedMinor!: bigint;

  @Column({ name: 'balance_entry_id', type: 'bigint', nullable: true, transformer: bigintTransformer })
  balanceEntryId!: bigint | null;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ name: 'overdraft_limit_minor', type: 'bigint', transformer: bigintTransformer })
  overdraftLimitMinor!: bigint;

  @Column({ name: 'authorizes_balance', type: 'boolean' })
  authorizesBalance!: boolean;

  /** smallint bucket index (design §6.6): a count, not an amount, so `number` is correct. */
  @Column({ type: 'smallint' })
  bucket!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
