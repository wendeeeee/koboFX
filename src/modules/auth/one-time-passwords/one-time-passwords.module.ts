import { Module } from '@nestjs/common';
import { EmailModule } from '../../notifications/email/email.module';
import { GenerateAndDispatchOneTimePasswordService } from './generate-and-dispatch-one-time-password.service';
import { OneTimePasswordChallengeRepository } from './one-time-password-challenge.repository';
import { OneTimePasswordChallengeStore } from './one-time-password-challenge.store';

@Module({
  imports: [EmailModule],
  providers: [OneTimePasswordChallengeStore, OneTimePasswordChallengeRepository, GenerateAndDispatchOneTimePasswordService],
  exports: [OneTimePasswordChallengeStore, OneTimePasswordChallengeRepository, GenerateAndDispatchOneTimePasswordService],
})
export class OneTimePasswordsModule {}
