import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../../database/bigint.transformer';
import { EntryDirection } from '../ledger.types';

/** Read model of `ledger_entries` (design §5.5): append-only, hash-chained per account. */
@Entity('ledger_entries')
export class LedgerEntryEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id!: bigint;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'currency_code', type: 'char', length: 3 })
  currencyCode!: string;

  @Column({ type: 'enum', enum: EntryDirection, enumName: 'entry_direction' })
  direction!: EntryDirection;

  @Column({ name: 'amount_minor', type: 'bigint', transformer: bigintTransformer })
  amountMinor!: bigint;

  @Column({ name: 'balance_after_minor', type: 'bigint', transformer: bigintTransformer })
  balanceAfterMinor!: bigint;

  @Column({ name: 'value_time', type: 'timestamptz' })
  valueTime!: Date;

  @Column({ name: 'booking_time', type: 'timestamptz' })
  bookingTime!: Date;

  @Column({ name: 'previous_hash', type: 'bytea', nullable: true })
  previousHash!: Buffer | null;

  @Column({ name: 'entry_hash', type: 'bytea' })
  entryHash!: Buffer;
}
