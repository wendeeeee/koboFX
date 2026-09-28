import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { OutboxModule } from '../outbox/outbox.module';
import { UsersModule } from '../users/users.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AccountCreationService } from './account-creation.service';
import { AuthController } from './auth.controller';
import { LoginService } from './login.service';
import { OneTimePasswordsModule } from './one-time-passwords/one-time-passwords.module';
import { PasswordHasher } from './passwords/password-hasher';
import { SessionService } from './session.service';
import { AccessTokenService } from './tokens/access-token.service';
import { RefreshTokenService } from './tokens/refresh-token.service';
import { VerificationService } from './verification.service';

/**
 * Authentication (design §7.1, §9.1): register · verify · resend · login · refresh ·
 * logout. The guards live in `common/guards` and are registered globally by
 * `AppModule`; they use `AccessTokenService` and `UserRepository` from here.
 */
@Module({
  // Keys and algorithm are passed per call (AccessTokenService), never module defaults.
  imports: [JwtModule.register({}), UsersModule, WalletsModule, OutboxModule, AuditModule, OneTimePasswordsModule],
  controllers: [AuthController],
  providers: [
    AccessTokenService,
    RefreshTokenService,
    PasswordHasher,
    SessionService,
    AccountCreationService,
    VerificationService,
    LoginService,
  ],
  exports: [AccessTokenService, RefreshTokenService, PasswordHasher, UsersModule],
})
export class AuthModule {}
