import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../../database/bigint.transformer';
import { ReservationExpiryPolicy, ReservationStatus } from '../reservation.types';

/**
 * Read model of `reservations` (design §6.3). Written ONLY by `ReservationService`,
 * under the account's row lock; never save this entity to change a reservation.
 */
@Entity('reservations')
export class ReservationEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ name: 'flow_id', type: 'uuid' })
  flowId!: string;

  @Column({ name: 'amount_minor', type: 'bigint', transformer: bigintTransformer })
  amountMinor!: bigint;

  @Column({ name: 'settled_minor', type: 'bigint', nullable: true, transformer: bigintTransformer })
  settledMinor!: bigint | null;

  @Column({ name: 'settlement_transaction_id', type: 'uuid', nullable: true })
  settlementTransactionId!: string | null;

  @Column({ type: 'enum', enum: ReservationStatus, enumName: 'reservation_status' })
  status!: ReservationStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'expiry_policy', type: 'enum', enum: ReservationExpiryPolicy, enumName: 'reservation_expiry_policy' })
  expiryPolicy!: ReservationExpiryPolicy;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;
}
