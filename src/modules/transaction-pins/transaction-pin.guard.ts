import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { InvariantViolationError } from '../../common/errors';
import type { AuthenticatedUser } from '../../common/guards/authenticated-request';
import { TRANSACTION_PIN_PATTERN } from './transaction-pin';
import { TransactionPinService } from './transaction-pin.service';

/**
 * The final confirmation of a money route (`transactionPin` in the body), checked BEFORE the idempotency barrier opens
 * its transaction. `verify` counts a wrong guess in its own committed transaction; done inside the barrier that would
 * hold two pooled connections per request, and a burst as large as the pool would wait on itself forever.
 *
 * Runs after the global guards (authenticated, ACTIVE, per-user rate limit). A PIN that is not 6 digits is left to the
 * DTO (`TransactionPinField`, the same pattern), which refuses the body before any handler runs — so the pipeline's own
 * 400s (validation, a missing `Idempotency-Key`) answer exactly as on every other route. A same-key replay is checked
 * again: whoever presents a stored answer must still know the PIN.
 */
@Injectable()
export class TransactionPinGuard implements CanActivate {
  constructor(private readonly pins: TransactionPinService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    if (!request.user) throw new InvariantViolationError('TransactionPinGuard runs after authentication.');
    const pin: unknown = (request.body as Record<string, unknown> | undefined)?.transactionPin;
    if (typeof pin !== 'string' || !TRANSACTION_PIN_PATTERN.test(pin)) return true;
    await this.pins.verify(request.user.id, pin);
    return true;
  }
}
