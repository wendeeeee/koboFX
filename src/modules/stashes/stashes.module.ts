import { Module } from '@nestjs/common';
import { StashController } from './stash.controller';
import { StashService } from './stash.service';

/** Read-only stash projections (WITHDRAWAL_PLAN.md §J, §K). Loaded whatever the withdrawal switches say: reads never stop. */
@Module({
  controllers: [StashController],
  providers: [StashService],
  exports: [StashService],
})
export class StashesModule {}
