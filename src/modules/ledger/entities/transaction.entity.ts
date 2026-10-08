import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../../database/bigint.transformer';
import { TransactionStatus, TransactionType } from '../ledger.types';

/** Read model of `transactions`. */
@Entity('transactions')
export class TransactionEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  reference!: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'enum', enum: TransactionType, enumName: 'transaction_type' })
  type!: TransactionType;

  @Column({ type: 'enum', enum: TransactionStatus, enumName: 'transaction_status' })
  status!: TransactionStatus;

  @Column({ name: 'source_currency', type: 'char', length: 3, nullable: true })
  sourceCurrency!: string | null;

  @Column({ name: 'source_amount_minor', type: 'bigint', nullable: true, transformer: bigintTransformer })
  sourceAmountMinor!: bigint | null;

  @Column({ name: 'target_currency', type: 'char', length: 3, nullable: true })
  targetCurrency!: string | null;

  @Column({ name: 'target_amount_minor', type: 'bigint', nullable: true, transformer: bigintTransformer })
  targetAmountMinor!: bigint | null;

  @Column({ name: 'rate_display', type: 'numeric', precision: 24, scale: 12, nullable: true })
  rateDisplay!: string | null;

  @Column({ name: 'reference_rate', type: 'numeric', precision: 24, scale: 12, nullable: true })
  referenceRate!: string | null;

  @Column({ name: 'rate_provider', type: 'text', nullable: true })
  rateProvider!: string | null;

  @Column({ name: 'rate_fetched_at', type: 'timestamptz', nullable: true })
  rateFetchedAt!: Date | null;

  @Column({ name: 'spread_basis_points', type: 'integer', nullable: true })
  spreadBasisPoints!: number | null;

  @Column({ name: 'quote_id', type: 'uuid', nullable: true })
  quoteId!: string | null;

  @Column({ name: 'value_time', type: 'timestamptz' })
  valueTime!: Date;

  @Column({ name: 'booking_time', type: 'timestamptz' })
  bookingTime!: Date;

  @Column({ name: 'settlement_time', type: 'timestamptz', nullable: true })
  settlementTime!: Date | null;

  @Column({ name: 'initiated_by', type: 'text' })
  initiatedBy!: string;

  @Column({ name: 'reason_code', type: 'text', nullable: true })
  reasonCode!: string | null;

  @Column({ name: 'corrects_transaction_id', type: 'uuid', nullable: true })
  correctsTransactionId!: string | null;

  @Column({ name: 'corrected_by_transaction_id', type: 'uuid', nullable: true })
  correctedByTransactionId!: string | null;

  @Column({ name: 'idempotency_key', type: 'text', nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'external_reference', type: 'text', nullable: true })
  externalReference!: string | null;

  @Column({ name: 'failure_code', type: 'text', nullable: true })
  failureCode!: string | null;

  @Column({ type: 'jsonb' })
  metadata!: Record<string, unknown>;
}
