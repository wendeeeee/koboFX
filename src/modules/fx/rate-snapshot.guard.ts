import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { FxRateService, ServedSnapshot } from './fx-rate.service';

const PREPARED_SNAPSHOT = Symbol('fxPreparedRateSnapshot');

type RequestWithSnapshot = { [PREPARED_SNAPSHOT]?: ServedSnapshot };

@Injectable()
export class RateSnapshotGuard implements CanActivate {
  constructor(private readonly rates: FxRateService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSnapshot>();
    request[PREPARED_SNAPSHOT] = await this.rates.prepareExecutable();
    return true;
  }
}

export const PreparedRateSnapshot = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ServedSnapshot | undefined =>
    context.switchToHttp().getRequest<RequestWithSnapshot>()[PREPARED_SNAPSHOT],
);
