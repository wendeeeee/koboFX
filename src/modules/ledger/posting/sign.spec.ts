import fc from 'fast-check';
import { AccountType, EntryDirection, NormalSide } from '../ledger.types';
import { balanceTowardsTypeTotal, oppositeDirection, signedBalanceChange, standardNormalSide } from './sign';

describe('sign logic (data-driven from normal_side, design §5.1)', () => {
  it.each([
    [NormalSide.DEBIT, EntryDirection.DEBIT, 100n],
    [NormalSide.DEBIT, EntryDirection.CREDIT, -100n],
    [NormalSide.CREDIT, EntryDirection.CREDIT, 100n],
    [NormalSide.CREDIT, EntryDirection.DEBIT, -100n],
  ])('a %s-normal account hit by a %s of 100 changes by %s', (normalSide, direction, expected) => {
    expect(signedBalanceChange(normalSide, direction, 100n)).toBe(expected);
  });

  it('a user balance is a liability: crediting it means we owe more, debiting means we owe less', () => {
    const userSide = standardNormalSide(AccountType.LIABILITY);
    expect(signedBalanceChange(userSide, EntryDirection.CREDIT, 5n)).toBe(5n);
    expect(signedBalanceChange(userSide, EntryDirection.DEBIT, 5n)).toBe(-5n);
  });

  it.each([
    [AccountType.ASSET, NormalSide.DEBIT],
    [AccountType.EXPENSE, NormalSide.DEBIT],
    [AccountType.LIABILITY, NormalSide.CREDIT],
    [AccountType.EQUITY, NormalSide.CREDIT],
    [AccountType.REVENUE, NormalSide.CREDIT],
  ])('%s accounts increase on the %s side', (type, side) => {
    expect(standardNormalSide(type)).toBe(side);
  });

  it('for any amount, the same entry on opposite normal sides moves balances in opposite directions', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 2n ** 62n }), fc.constantFrom(...Object.values(EntryDirection)), (amount, direction) => {
        expect(signedBalanceChange(NormalSide.DEBIT, direction, amount)).toBe(
          -signedBalanceChange(NormalSide.CREDIT, direction, amount),
        );
      }),
    );
  });

  it('a balanced debit/credit pair nets to zero in the debit-positive view, whatever the accounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 2n ** 62n }),
        fc.constantFrom(...Object.values(NormalSide)),
        fc.constantFrom(...Object.values(NormalSide)),
        (amount, debitedSide, creditedSide) => {
          const debitPositive = (side: NormalSide, change: bigint) => (side === NormalSide.DEBIT ? change : -change);
          const debitLeg = debitPositive(debitedSide, signedBalanceChange(debitedSide, EntryDirection.DEBIT, amount));
          const creditLeg = debitPositive(creditedSide, signedBalanceChange(creditedSide, EntryDirection.CREDIT, amount));
          expect(debitLeg + creditLeg).toBe(0n);
        },
      ),
    );
  });

  it('counts a contra account (normal side opposite its type) negatively towards its type total', () => {
    expect(balanceTowardsTypeTotal(AccountType.ASSET, NormalSide.DEBIT, 70n)).toBe(70n);
    expect(balanceTowardsTypeTotal(AccountType.ASSET, NormalSide.CREDIT, 70n)).toBe(-70n);
    expect(balanceTowardsTypeTotal(AccountType.EQUITY, NormalSide.CREDIT, -3n)).toBe(-3n);
  });

  it('oppositeDirection flips and is its own inverse', () => {
    expect(oppositeDirection(EntryDirection.DEBIT)).toBe(EntryDirection.CREDIT);
    expect(oppositeDirection(EntryDirection.CREDIT)).toBe(EntryDirection.DEBIT);
  });
});
