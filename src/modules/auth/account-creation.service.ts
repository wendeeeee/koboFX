import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../audit/audit-log.service';
import { OutboxService } from '../outbox/outbox.service';
import { OutboxEventType } from '../outbox/outbox.types';
import { UserRepository } from '../users/user.repository';
import { UserStatus } from '../users/user.types';
import { WalletProvisioningService } from '../wallets/wallet-provisioning.service';
import { PasswordHasher } from './passwords/password-hasher';

export type RegistrationOutcome = 'CREATED' | 'PENDING_RENEWED' | 'ALREADY_REGISTERED';

/**
 * `POST /auth/register` (design §7.1). The caller always gets the same response; what
 * happens behind it (decision #5):
 *
 * - New email: user (PENDING_VERIFICATION) + wallet + `USER:{walletId}:NGN` + an
 *   `EmailVerificationRequested.v1` outbox event + audit row — ONE transaction.
 * - Email pending verification: the new password REPLACES the old one and a fresh
 *   code is requested. The account is never squatted: whoever proves the mailbox, with
 *   the password they chose, activates it (verify requires both).
 * - Email already active or suspended: nothing changes; the owner is told by email.
 *
 * The password is hashed first on every path, so all three cost the same argon2 work.
 * No Redis and no SMTP on this path: registration never depends on either.
 */
@Injectable()
export class AccountCreationService {
  private readonly logger = new Logger(AccountCreationService.name);

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly users: UserRepository,
    private readonly wallets: WalletProvisioningService,
    private readonly outbox: OutboxService,
    private readonly auditLog: AuditLogService,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async register(email: string, password: string): Promise<RegistrationOutcome> {
    const passwordHash = await this.passwordHasher.hash(password);
    const { outcome, userId } = await this.unitOfWork.run(async () => {
      const createdUserId = await this.users.insertPending(email, passwordHash);
      if (createdUserId) {
        await this.wallets.openWallet(createdUserId);
        await this.outbox.enqueue(OutboxEventType.EMAIL_VERIFICATION_REQUESTED, createdUserId, { userId: createdUserId });
        await this.auditLog.record({
          actor: { type: 'USER', id: createdUserId },
          action: AuditAction.USER_REGISTERED,
          subject: { type: AuditSubjectType.USER, id: createdUserId },
          after: { status: UserStatus.PENDING_VERIFICATION },
          reason: 'Self-registration',
        });
        return { outcome: 'CREATED' as const, userId: createdUserId };
      }

      const existing = await this.users.lockByEmail(email);
      if (existing.status === UserStatus.PENDING_VERIFICATION) {
        await this.users.replacePasswordHash(existing.id, passwordHash);
        await this.outbox.enqueue(OutboxEventType.EMAIL_VERIFICATION_REQUESTED, existing.id, { userId: existing.id });
        await this.auditLog.record({
          actor: { type: 'SYSTEM' },
          action: AuditAction.PENDING_REGISTRATION_PASSWORD_REPLACED,
          subject: { type: AuditSubjectType.USER, id: existing.id },
          reason: 'Registration repeated for an email still pending verification',
        });
        return { outcome: 'PENDING_RENEWED' as const, userId: existing.id };
      }
      await this.outbox.enqueue(OutboxEventType.EXISTING_ACCOUNT_REGISTRATION_ATTEMPTED, existing.id, {
        userId: existing.id,
      });
      return { outcome: 'ALREADY_REGISTERED' as const, userId: existing.id };
    });
    this.logger.log({ userId, outcome }, 'Registration processed');
    return outcome;
  }
}
