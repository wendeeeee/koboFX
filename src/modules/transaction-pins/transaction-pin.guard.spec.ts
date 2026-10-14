import { ExecutionContext } from '@nestjs/common';
import { InvariantViolationError } from '../../common/errors';
import { TransactionPinGuard } from './transaction-pin.guard';
import { TransactionPinService } from './transaction-pin.service';
import { TransactionPinInvalidError } from './transaction-pins.errors';

const USER_ID = '8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('TransactionPinGuard', () => {
  const verify = jest.fn<Promise<void>, [string, string]>();
  const guard = new TransactionPinGuard({ verify } as unknown as TransactionPinService);
  beforeEach(() => verify.mockReset().mockResolvedValue(undefined));

  it('verifies a well-formed PIN for the authenticated user', async () => {
    await expect(guard.canActivate(contextFor({ user: { id: USER_ID }, body: { transactionPin: '402815' } }))).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith(USER_ID, '402815');
  });

  it('lets the refusal through (a wrong PIN never reaches the barrier or the handler)', async () => {
    verify.mockRejectedValue(new TransactionPinInvalidError(4));
    await expect(guard.canActivate(contextFor({ user: { id: USER_ID }, body: { transactionPin: '999990' } }))).rejects.toBeInstanceOf(TransactionPinInvalidError);
  });

  it.each([undefined, '', '12345', '1234567', '12a456', 402815, '١٢٣٤٥٦'])('leaves a malformed PIN (%p) to the DTO, verifying nothing', async (transactionPin) => {
    await expect(guard.canActivate(contextFor({ user: { id: USER_ID }, body: { transactionPin } }))).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses to run before authentication', async () => {
    await expect(guard.canActivate(contextFor({ body: { transactionPin: '402815' } }))).rejects.toBeInstanceOf(InvariantViolationError);
  });
});
