import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { FxRateService, ServedSnapshot } from './fx-rate.service';

const PREPARED_SNAPSHOT = Symbol('fxPreparedRateSnapshot');

type RequestWithSnapshot = { [PREPARED_SNAPSHOT]?: ServedSnapshot };

/**
 * Prepares an executable rate snapshot BEFORE the idempotency barrier opens its
 * transaction (Phase 6 §5.7; the answer Phase 7's convert reuses). Route guards run after
 * the global guards and before every interceptor, so any provider call here — the
 * bounded, single-flighted catch-up — happens with no transaction open.
 *
 * It never denies: the decision (executable, or `503 FX_RATE_STALE`) is made by the
 * handler inside the barrier, so a replayed request still gets its stored response.
 */
@Injectable()
export class RateSnapshotGuard implements CanActivate {
  constructor(private readonly rates: FxRateService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSnapshot>();
    request[PREPARED_SNAPSHOT] = await this.rates.prepareExecutable();
    return true;
  }
}

/** The snapshot `RateSnapshotGuard` prepared for this request (undefined if none could be read). */
export const PreparedRateSnapshot = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ServedSnapshot | undefined =>
    context.switchToHttp().getRequest<RequestWithSnapshot>()[PREPARED_SNAPSHOT],
);
