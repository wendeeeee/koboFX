import { Injectable, Logger } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { RedisService } from '../../redis/redis.service';
import { GenerateAndDispatchOneTimePasswordService } from '../auth/one-time-passwords/generate-and-dispatch-one-time-password.service';
import {
  ClaimedOutboxEvent,
  ConversionPostedPayload,
  FundingPostedPayload,
  OutboxEventHandler,
  OutboxEventType,
  UserEventPayload,
} from '../outbox/outbox.types';
import { UserRepository } from '../users/user.repository';
import { EmailSender } from './email/email-sender';
import { existingAccountEmail } from './email/email-templates';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function userIdOf(event: ClaimedOutboxEvent): string {
  const userId = (event.payload as Partial<UserEventPayload> | null)?.userId;
  if (typeof userId !== 'string' || !UUID.test(userId) || userId !== event.aggregateId) {
    throw new InvariantViolationError(`Outbox event ${event.id} has a malformed payload.`);
  }
  return userId;
}

@Injectable()
export class EmailVerificationRequestedHandler implements OutboxEventHandler {
  readonly eventType = OutboxEventType.EMAIL_VERIFICATION_REQUESTED;

  constructor(private readonly oneTimePasswords: GenerateAndDispatchOneTimePasswordService) {}

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    await this.oneTimePasswords.dispatchEmailVerification(userIdOf(event), event.id);
  }
}

export const EXISTING_ACCOUNT_NOTICE_INTERVAL_SECONDS = 3600;


@Injectable()
export class ExistingAccountRegistrationAttemptedHandler implements OutboxEventHandler {
  readonly eventType = OutboxEventType.EXISTING_ACCOUNT_REGISTRATION_ATTEMPTED;
  private readonly logger = new Logger(ExistingAccountRegistrationAttemptedHandler.name);

  constructor(
    private readonly users: UserRepository,
    private readonly emailSender: EmailSender,
    private readonly redis: RedisService,
  ) {}

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const userId = userIdOf(event);
    const user = await this.users.findProfile(userId);
    if (!user) throw new InvariantViolationError(`Outbox event ${event.id} names a user that does not exist.`);
    const claimed = await this.redis.evaluate(
      `return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) and 1 or 0`,
      [`notice:existing-account:${userId}`],
      [event.id, EXISTING_ACCOUNT_NOTICE_INTERVAL_SECONDS],
    );
    if (claimed !== 1) {
      this.logger.log({ userId }, 'Existing-account notice skipped: one was sent recently');
      return;
    }
    await this.emailSender.send(existingAccountEmail(user.email));
    this.logger.log({ userId }, 'Existing-account notice sent');
  }
}

export function conversionPostedOf(event: ClaimedOutboxEvent): ConversionPostedPayload {
  const payload = (event.payload ?? {}) as Partial<ConversionPostedPayload>;
  const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
  if (
    !isId(payload.transactionId) || payload.transactionId !== event.aggregateId ||
    !isId(payload.userId) || !isId(payload.flowId) ||
    !(payload.quoteId === null || isId(payload.quoteId))
  ) {
    throw new InvariantViolationError(`Outbox event ${event.id} has a malformed payload.`);
  }
  return { transactionId: payload.transactionId, userId: payload.userId, flowId: payload.flowId, quoteId: payload.quoteId };
}


@Injectable()
export class ConversionPostedHandler implements OutboxEventHandler {
  readonly eventType = OutboxEventType.CONVERSION_POSTED;
  private readonly logger = new Logger(ConversionPostedHandler.name);

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = conversionPostedOf(event);
    this.logger.log({ eventId: event.id, ...payload }, 'Conversion posted: acknowledged');
  }
}

export function fundingPostedOf(event: ClaimedOutboxEvent): FundingPostedPayload {
  const payload = (event.payload ?? {}) as Partial<FundingPostedPayload>;
  const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
  if (
    !isId(payload.transactionId) || payload.transactionId !== event.aggregateId ||
    !isId(payload.userId) || !isId(payload.flowId) ||
    typeof payload.provider !== 'string' || !/^[a-z0-9-]{1,32}$/.test(payload.provider)
  ) {
    throw new InvariantViolationError(`Outbox event ${event.id} has a malformed payload.`);
  }
  return { transactionId: payload.transactionId, userId: payload.userId, flowId: payload.flowId, provider: payload.provider };
}


@Injectable()
export class FundingPostedHandler implements OutboxEventHandler {
  readonly eventType = OutboxEventType.FUNDING_POSTED;
  private readonly logger = new Logger(FundingPostedHandler.name);

  async handle(event: ClaimedOutboxEvent): Promise<void> {
    const payload = fundingPostedOf(event);
    this.logger.log({ eventId: event.id, ...payload }, 'Funding posted: acknowledged');
  }
}
