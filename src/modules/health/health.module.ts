import { Module } from '@nestjs/common';
import { FxModule } from '../fx/fx.module';
import { HealthController } from './health.controller';

@Module({ imports: [FxModule], controllers: [HealthController] })
export class HealthModule {}
