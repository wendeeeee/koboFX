import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('currencies')
export class CurrencyEntity {
  @PrimaryColumn({ type: 'char', length: 3 })
  code!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  symbol!: string;

  @Column({ name: 'minor_unit', type: 'smallint' })
  minorUnit!: number;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
