import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../../database/bigint.transformer';

/** A closed reporting period `[periodStart, periodEnd)` (design §5.3). */
@Entity('period_locks')
export class PeriodLockEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id!: bigint;

  @Column({ name: 'period_start', type: 'timestamptz' })
  periodStart!: Date;

  @Column({ name: 'period_end', type: 'timestamptz' })
  periodEnd!: Date;

  @Column({ name: 'locked_at', type: 'timestamptz' })
  lockedAt!: Date;

  @Column({ name: 'locked_by', type: 'text' })
  lockedBy!: string;

  @Column({ type: 'text' })
  reason!: string;
}
