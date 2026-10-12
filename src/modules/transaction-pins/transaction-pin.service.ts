import { Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { EntityManager } from 'typeorm';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { TRANSACTION_PIN_MAXIMUM_ATTEMPTS } from '../../database/migrations/1791849600001-CreateTransactionPins';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AuditAction, AuditLogService, AuditSubjectType } from '../audit/audit-log.service';
import {
  ONE_TIME_PASSWORD_MAXIMUM_ATTEMPTS,
  ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS,
  OneTimePasswordPurpose,
  oneTimePasswordMatches,
} from '../auth/one-time-passwords/one-time-password';
import { OneTimePasswordChallengeOutcome, OneTimePasswordChallengeRepository } from '../auth/one-time-passwords/one-time-password-challenge.repository';
import { OneTimePasswordChallengeStore } from '../auth/one-time-passwords/one-time-password-challenge.store';
import { PASSWORD_HASHING_OPTIONS, PasswordHasher } from '../auth/passwords/password-hasher';
import { TransactionPinChange } from '../notifications/email/email-templates';
import { OutboxService } from '../outbox/outbox.service';
import { OutboxEventType } from '../outbox/outbox.types';
import { UserRepository } from '../users/user.repository';
import { transactionPinDigest, transactionPinWeakness } from './transaction-pin';
import {
  PasswordIncorrectError,
  TransactionPinAlreadySetError,
  TransactionPinInvalidError,
  TransactionPinLockedError,
  TransactionPinNotSetError,
  TransactionPinResetCodeInvalidError,
  TransactionPinTooWeakError,
} from './transaction-pins.errors';

export { TRANSACTION_PIN_MAXIMUM_ATTEMPTS };

export interface TransactionPinStatus {
  readonly set: boolean;
  readonly locked: boolean;
}

export interface TransactionPinResetCodeRequested {
  readonly status: 'REQUESTED';
  readonly channel: 'EMAIL';
  readonly expiresInSeconds: number;
}

interface PinRow {
  readonly pin_hash: string;
  readonly failed_attempts: number;
  readonly locked_at: Date | null;
}

type Verdict = { kind: 'OK' } | { kind: 'WRONG'; attemptsRemaining: number } | { kind: 'LOCKED' } | { kind: 'NOT_SET' };

const RESET_PURPOSE = OneTimePasswordPurpose.RESET_TRANSACTION_PIN;

/**
 * The transaction PIN (2026-10-12 decision): the final confirmation of every withdrawal, market conversion and quoted
 * trade. One 6-digit PIN per user, stored only as argon2id over a peppered HMAC (`transaction-pin.ts`).
 *
 * - **Create** needs the account password (a borrowed unlocked session cannot set it).
 * - **Change** needs the current PIN; **reset** (forgotten or locked) needs the password and an emailed code.
 * - **Verify** runs before any money is touched — from `TransactionPinGuard`, before the idempotency barrier opens its
 *   transaction, so a request never holds two pooled connections — in its OWN transaction holding the PIN row `FOR UPDATE`: wrong guesses
 *   are counted even when the request they guard is refused, and simultaneous guesses are serialised, so no burst can
 *   get past the lock. `TRANSACTION_PIN_MAXIMUM_ATTEMPTS` (5) consecutive wrong PINs lock it until a reset.
 * - Every change is audited and announced by email (`TransactionPinChanged.v1`); the PIN itself never leaves this
 *   service — not in a log, an audit row, an outbox payload or an error.
 */
@Injectable()
export class TransactionPinService {
  private readonly logger = new Logger(TransactionPinService.name);
  private readonly pepper: Buffer;
  private readonly codePepper: Buffer;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly users: UserRepository,
    private readonly passwords: PasswordHasher,
    private readonly codes: OneTimePasswordChallengeStore,
    private readonly challenges: OneTimePasswordChallengeRepository,
    private readonly audit: AuditLogService,
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.pepper = config.authentication.transactionPinPepper;
    this.codePepper = config.authentication.oneTimePasswordPepper;
  }

  status(userId: string): Promise<TransactionPinStatus> {
    return this.users.findTransactionPinState(userId);
  }

  async create(userId: string, pin: string, password: string): Promise<TransactionPinStatus> {
    this.assertStrong(pin);
    await this.assertPassword(userId, password);
    const pinHash = await this.hash(userId, pin);
    await this.unitOfWork.run(async (manager) => {
      const inserted = (await manager.query(
        `INSERT INTO transaction_pins (user_id, pin_hash) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
        [userId, pinHash],
      )) as unknown[];
      if (inserted.length === 0) throw new TransactionPinAlreadySetError();
      await this.record(userId, 'CREATED', AuditAction.TRANSACTION_PIN_CREATED, 'Transaction PIN created (password confirmed)');
    });
    return { set: true, locked: false };
  }

  async change(userId: string, currentPin: string, newPin: string): Promise<TransactionPinStatus> {
    this.assertStrong(newPin);
    if (newPin === currentPin) throw new TransactionPinTooWeakError('must differ from your current PIN');
    try {
      await this.verify(userId, currentPin);
    } catch (error) {
      // A retry of a change that already succeeded: the stored PIN is already the new one. Knowing the stored PIN is a
      // correct PIN, so the attempt the old one just cost is cleared exactly as a correct `verify` would.
      if (error instanceof TransactionPinInvalidError && (await this.recogniseRetriedChange(userId, newPin))) return { set: true, locked: false };
      throw error;
    }
    const pinHash = await this.hash(userId, newPin);
    await this.unitOfWork.run(async (manager) => {
      await manager.query(`UPDATE transaction_pins SET pin_hash = $2, changed_at = now() WHERE user_id = $1`, [userId, pinHash]);
      await this.record(userId, 'CHANGED', AuditAction.TRANSACTION_PIN_CHANGED, 'Transaction PIN changed (current PIN confirmed)');
    });
    return { set: true, locked: false };
  }

  /** Email a reset code (the worker generates it). Only an existing PIN can be reset. */
  async requestResetCode(userId: string): Promise<TransactionPinResetCodeRequested> {
    if (!(await this.status(userId)).set) throw new TransactionPinNotSetError();
    await this.unitOfWork.run(() => this.outbox.enqueue(OutboxEventType.TRANSACTION_PIN_RESET_CODE_REQUESTED, userId, { userId }));
    this.logger.log({ userId }, 'Transaction PIN reset code requested');
    return { status: 'REQUESTED', channel: 'EMAIL', expiresInSeconds: ONE_TIME_PASSWORD_TIME_TO_LIVE_SECONDS };
  }

  /** Forgotten or locked: password + the emailed code → a new PIN, attempts cleared, unlocked. */
  async reset(userId: string, password: string, oneTimePassword: string, newPin: string): Promise<TransactionPinStatus> {
    this.assertStrong(newPin);
    if (!(await this.status(userId)).set) throw new TransactionPinNotSetError();
    await this.assertPassword(userId, password);
    const attempt = await this.codes.attempt(RESET_PURPOSE, userId, ONE_TIME_PASSWORD_MAXIMUM_ATTEMPTS);
    if (attempt.kind === 'GONE' || !oneTimePasswordMatches(this.codePepper, attempt.challengeId, oneTimePassword, attempt.hmac)) {
      // A retry of a reset that already succeeded (its code is consumed): the stored PIN is already the new one.
      if (attempt.kind === 'GONE' && (await this.matchesStoredUnlocked(userId, newPin))) return { set: true, locked: false };
      if (attempt.kind === 'EVALUATE' && attempt.lastAttempt) await this.challenges.resolve(attempt.challengeId, OneTimePasswordChallengeOutcome.EXHAUSTED);
      throw new TransactionPinResetCodeInvalidError();
    }
    if (!attempt.lastAttempt && !(await this.codes.consume(RESET_PURPOSE, userId, attempt.challengeId))) throw new TransactionPinResetCodeInvalidError();
    const pinHash = await this.hash(userId, newPin);
    await this.unitOfWork.run(async (manager) => {
      await manager.query(
        `UPDATE transaction_pins SET pin_hash = $2, failed_attempts = 0, locked_at = NULL, changed_at = now() WHERE user_id = $1`,
        [userId, pinHash],
      );
      await this.challenges.resolve(attempt.challengeId, OneTimePasswordChallengeOutcome.CONSUMED);
      await this.record(userId, 'RESET', AuditAction.TRANSACTION_PIN_RESET, 'Transaction PIN reset (password and emailed code confirmed)');
    });
    return { set: true, locked: false };
  }

  /**
   * The guard on money: resolves when `pin` is this user's PIN, else throws NOT_SET / INVALID (with attempts left) /
   * LOCKED. Runs in its own committed transaction (`runIndependent`), so a wrong guess counts even when the caller's
   * request is refused; the PIN row is locked `FOR UPDATE` for the check, so concurrent guesses are counted one by one.
   */
  async verify(userId: string, pin: string): Promise<void> {
    const verdict = await this.unitOfWork.runIndependent((manager) => this.decide(manager, userId, pin));
    if (verdict.kind === 'OK') return;
    if (verdict.kind === 'NOT_SET') throw new TransactionPinNotSetError();
    if (verdict.kind === 'LOCKED') throw new TransactionPinLockedError();
    throw new TransactionPinInvalidError(verdict.attemptsRemaining);
  }

  private async decide(manager: EntityManager, userId: string, pin: string): Promise<Verdict> {
    const [row] = (await manager.query(
      `SELECT pin_hash, failed_attempts, locked_at FROM transaction_pins WHERE user_id = $1 FOR UPDATE`,
      [userId],
    )) as PinRow[];
    if (!row) return { kind: 'NOT_SET' };
    if (row.locked_at !== null) return { kind: 'LOCKED' };
    if (await this.matches(row.pin_hash, userId, pin)) {
      if (row.failed_attempts > 0) await manager.query(`UPDATE transaction_pins SET failed_attempts = 0 WHERE user_id = $1`, [userId]);
      return { kind: 'OK' };
    }
    const attempts = row.failed_attempts + 1;
    if (attempts >= TRANSACTION_PIN_MAXIMUM_ATTEMPTS) {
      await manager.query(`UPDATE transaction_pins SET failed_attempts = $2, locked_at = now() WHERE user_id = $1`, [userId, attempts]);
      await this.record(userId, 'LOCKED', AuditAction.TRANSACTION_PIN_LOCKED, `Transaction PIN locked after ${attempts} wrong attempts`);
      this.logger.warn({ userId }, 'Transaction PIN locked after too many wrong attempts');
      return { kind: 'LOCKED' };
    }
    await manager.query(`UPDATE transaction_pins SET failed_attempts = $2 WHERE user_id = $1`, [userId, attempts]);
    return { kind: 'WRONG', attemptsRemaining: TRANSACTION_PIN_MAXIMUM_ATTEMPTS - attempts };
  }

  private assertStrong(pin: string): void {
    const weakness = transactionPinWeakness(pin);
    if (weakness) throw new TransactionPinTooWeakError(weakness);
  }

  private async assertPassword(userId: string, password: string): Promise<void> {
    const credentials = await this.users.findCredentials(userId);
    const ok = credentials ? await this.passwords.verify(credentials.passwordHash, password) : await this.passwords.verifyAgainstDummy(password);
    if (!ok) throw new PasswordIncorrectError();
  }

  private hash(userId: string, pin: string): Promise<string> {
    return argon2.hash(transactionPinDigest(this.pepper, userId, pin), PASSWORD_HASHING_OPTIONS);
  }

  private async matches(pinHash: string, userId: string, pin: string): Promise<boolean> {
    try {
      return await argon2.verify(pinHash, transactionPinDigest(this.pepper, userId, pin));
    } catch {
      return false;
    }
  }

  /** `pin` is the stored PIN of an unlocked row ⇒ the count is cleared (as by a correct `verify`), under the row lock. */
  private recogniseRetriedChange(userId: string, pin: string): Promise<boolean> {
    return this.unitOfWork.runIndependent(async (manager) => {
      const [row] = (await manager.query(
        `SELECT pin_hash, failed_attempts, locked_at FROM transaction_pins WHERE user_id = $1 FOR UPDATE`,
        [userId],
      )) as PinRow[];
      if (!row || row.locked_at !== null || !(await this.matches(row.pin_hash, userId, pin))) return false;
      if (row.failed_attempts > 0) await manager.query(`UPDATE transaction_pins SET failed_attempts = 0 WHERE user_id = $1`, [userId]);
      return true;
    });
  }

  private async matchesStoredUnlocked(userId: string, pin: string): Promise<boolean> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT pin_hash, locked_at FROM transaction_pins WHERE user_id = $1`, [userId])) as PinRow[];
    return row !== undefined && row.locked_at === null && (await this.matches(row.pin_hash, userId, pin));
  }

  /** Audit row + security-notice event, in the ambient transaction (the change's own, or `verify`'s independent one). */
  private async record(userId: string, change: TransactionPinChange, action: AuditAction, reason: string): Promise<void> {
    await this.audit.record({
      actor: change === 'LOCKED' ? { type: 'SYSTEM' } : { type: 'USER', id: userId },
      action,
      subject: { type: AuditSubjectType.USER, id: userId },
      after: { transactionPinSet: true, transactionPinLocked: change === 'LOCKED' },
      reason,
    });
    await this.outbox.enqueue(OutboxEventType.TRANSACTION_PIN_CHANGED, userId, { userId, change });
  }
}
