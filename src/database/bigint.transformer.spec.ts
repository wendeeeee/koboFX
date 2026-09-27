import { InvariantViolationError } from '../common/errors';
import { bigintTransformer } from './bigint.transformer';
import { Transactional } from './transaction/transactional.decorator';

describe('bigintTransformer', () => {
  it('reads BIGINT strings exactly, including beyond Number.MAX_SAFE_INTEGER', () => {
    expect(bigintTransformer.from('9223372036854775807')).toBe(9223372036854775807n);
    expect(bigintTransformer.from('-9007199254740993')).toBe(-9007199254740993n);
    expect(bigintTransformer.from(null)).toBeNull();
  });

  it('refuses a number from the driver: precision may already be lost', () => {
    expect(() => bigintTransformer.from(9007199254740993)).toThrow(InvariantViolationError);
    expect(() => bigintTransformer.from('1.5')).toThrow(InvariantViolationError);
  });

  it('writes bigints as strings and passes other values through', () => {
    expect(bigintTransformer.to(9223372036854775807n)).toBe('9223372036854775807');
    expect(bigintTransformer.to(null)).toBeNull();
    const findOperator = { type: 'in' };
    expect(bigintTransformer.to(findOperator)).toBe(findOperator);
  });
});

describe('@Transactional', () => {
  it('fails loudly if used before a UnitOfWork exists, rather than running untransacted', async () => {
    class Service {
      @Transactional()
      async work(): Promise<string> {
        return 'ran';
      }
    }
    expect(() => new Service().work()).toThrow(/before UnitOfWork was initialised/);
  });
});
