import { Module } from '@nestjs/common';
import { UserRepository } from './user.repository';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController],
  providers: [UserRepository],
  exports: [UserRepository],
})
export class UsersModule {}
