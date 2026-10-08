import fc from 'fast-check';
import { Client } from 'pg';
import { DomainError, ErrorCode } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { Reservation, ReservationStatus, SettlementPosting } from '../../src/modules/reservations/reservation.types';
import { LedgerHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

/**
 * For any interleaving of reserve / settle / release / expire, direct user-initiated
 * and system-driven postings, and out-of-order retries, every invariant holds after
 * EVERY single step (design §11, handbook "Testing"): the ledger's §8.1 checks,
 * `reserved = Σ ACTIVE`, and an independent in-memory model of each balance, each
 * hold and each reservation's status. Retries and refusals have zero effect.
 */

const ACCOUNTS_PER_RUN = 3;
const MINUTE = 60 * 1000;

type Relation = 'less' | 'equal' | 'more';
type Operation =
  | { readonly kind: 'reserve'; readonly account: number; readonly amountMinor: bigint; readonly intoHold: boolean; readonly ttlMinutes: number }
  | { readonly kind: 'reserveRetry'; readonly pick: number; readonly sameAmount: boolean }
  | { readonly kind: 'settle'; readonly pick: number; readonly relation: Relation; readonly deltaMinor: bigint }
  | { readonly kind: 'settleRetry'; readonly pick: number; readonly sameAmount: boolean }
  | { readonly kind: 'release'; readonly pick: number }
  | { readonly kind: 'expire'; readonly advanceMinutes: number }
  | { readonly kind: 'userDebit'; readonly account: number; readonly amountMinor: bigint; readonly intoHold: boolean }
  | { readonly kind: 'systemDebit'; readonly account: number; readonly amountMinor: bigint }
  | { readonly kind: 'fund'; readonly account: number; readonly amountMinor: bigint };

const account = fc.integer({ min: 0, max: ACCOUNTS_PER_RUN - 1 });
const amount = fc.bigInt({ min: 1n, max: 60_000n });
/**
 * Uniform amounts rarely land in the narrow band that is covered by the total balance
 * but not by available, so a quarter of spends aim into it on purpose: they must be
 * refused FUNDS_RESERVED. Only the amount is steered; the expected outcome is still
 * computed independently by the model.
 */
const intoHold = fc.nat({ max: 3 }).map((n) => n === 0);
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ account, amountMinor: amount, intoHold: intoHold, ttlMinutes: fc.integer({ min: 1, max: 30 }) }).map((op) => ({ kind: 'reserve' as const, ...op })) },
  { weight: 2, arbitrary: fc.record({ pick: fc.nat(), sameAmount: fc.boolean() }).map((op) => ({ kind: 'reserveRetry' as const, ...op })) },
  {
    weight: 4,
    arbitrary: fc
      .record({ pick: fc.nat(), relation: fc.constantFrom<Relation>('less', 'equal', 'more'), deltaMinor: fc.bigInt({ min: 1n, max: 30_000n }) })
      .map((op) => ({ kind: 'settle' as const, ...op })),
  },
  { weight: 2, arbitrary: fc.record({ pick: fc.nat(), sameAmount: fc.boolean() }).map((op) => ({ kind: 'settleRetry' as const, ...op })) },
  { weight: 3, arbitrary: fc.nat().map((pick) => ({ kind: 'release' as const, pick })) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 40 }).map((advanceMinutes) => ({ kind: 'expire' as const, advanceMinutes })) },
  { weight: 2, arbitrary: fc.record({ account, amountMinor: amount, intoHold: intoHold }).map((op) => ({ kind: 'userDebit' as const, ...op })) },
  { weight: 1, arbitrary: fc.record({ account, amountMinor: amount }).map((op) => ({ kind: 'systemDebit' as const, ...op })) },
  { weight: 1, arbitrary: fc.record({ account, amountMinor: amount }).map((op) => ({ kind: 'fund' as const, ...op })) },
);

interface ModelAccount {
  readonly user: UserAccount;
  balance: bigint;
  reserved: bigint;
}
interface ModelReservation {
  readonly id: string;
  readonly flowId: string;
  readonly account: number;
  readonly amountMinor: bigint;
  readonly expiresAtMs: number;
  status: ReservationStatus;
  settledMinor: bigint | null;
  /** The last value the service returned for it — what a retry must reproduce exactly. */
  lastSeen: Reservation;
}

describe('Reservation properties (fast-check against real Postgres 16)', () => {
  let harness: LedgerHarness;
  let flowIds: string[] = [];
  /** A real flow id (reservations.flow_id is a foreign key since Phase 5). */
  const nextFlowId = (): string => {
    const id = flowIds.pop();
    if (!id) throw new Error('flow id pool exhausted');
    return id;
  };
  let owner: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness({ LEDGER_INTERNAL_BUCKETS: '4' });
    flowIds = await harness.newFlowIds(20000);
    owner = await harness.db.ownerClient();
  });

  afterAll(async () => {
    await owner?.end();
    await harness?.close();
  });

  const spend = (user: UserAccount, amountMinor: bigint): SettlementPosting => ({
    transaction: { type: TransactionType.WITHDRAWAL, valueTime: new Date(), initiatedBy: `user:${user.userId}`, userId: user.userId },
    entries: [
      { account: { accountId: user.accountId }, direction: EntryDirection.DEBIT, amount: Money.of(amountMinor, 'NGN') },
      { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(amountMinor, 'NGN') },
    ],
  });

  const debit = (user: UserAccount, amountMinor: bigint, authorization: PostingAuthorization) =>
    harness.ledger.post({
      transaction: {
        type: authorization === PostingAuthorization.USER_INITIATED ? TransactionType.WITHDRAWAL : TransactionType.WRITE_OFF,
        authorization,
        valueTime: new Date(),
        initiatedBy: authorization === PostingAuthorization.USER_INITIATED ? `user:${user.userId}` : 'job:property',
        userId: user.userId,
      },
      entries: spend(user, amountMinor).entries,
    });

  /** When steering into the hold, prefer an account that has such a band (something reserved, balance above available). */
  function steeredAccount(accounts: readonly ModelAccount[], index: number, intoHoldBand: boolean): ModelAccount {
    if (intoHoldBand) {
      const withBand = accounts.filter((model) => model.reserved > 0n && model.balance > 0n);
      if (withBand.length > 0) return withBand[index % withBand.length];
    }
    return accounts[index];
  }

  /** An amount above available but within the total balance, when there is such a band; else `amountMinor`. */
  function steeredAmount(model: ModelAccount, amountMinor: bigint, intoHoldBand: boolean): bigint {
    const floor = model.balance - model.reserved > 0n ? model.balance - model.reserved : 0n;
    if (!intoHoldBand || model.balance <= floor) return amountMinor;
    return floor + 1n + (amountMinor % (model.balance - floor));
  }

  /** The §6.2 gate, computed independently from the model's pre-state. */
  function expectedGate(model: ModelAccount, reductionMinor: bigint): ErrorCode | undefined {
    if (model.balance - model.reserved - reductionMinor >= 0n) return undefined;
    if (model.balance - reductionMinor >= 0n) return ErrorCode.FUNDS_RESERVED;
    return ErrorCode.INSUFFICIENT_FUNDS;
  }

  /** Run a command the model says must be refused; assert its code and that NOTHING was written. */
  async function expectRefusedWithoutEffect(work: () => Promise<unknown>, code: ErrorCode): Promise<void> {
    const before = await harness.snapshot();
    const error = await work().then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    expect(await harness.snapshot()).toEqual(before);
  }

  /** Run a retry the model says must be a no-op; assert the same result and zero additional effect. */
  async function expectRetryWithoutEffect(work: () => Promise<Reservation>, previous: Reservation): Promise<void> {
    const before = await harness.snapshot();
    expect(await work()).toEqual(previous);
    expect(await harness.snapshot()).toEqual(before);
  }

  it('for any interleaving, every invariant and the model hold after every single step', async () => {
    const counts: Record<string, number> = {};
    const count = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 0n, max: 100_000n }), { minLength: ACCOUNTS_PER_RUN, maxLength: ACCOUNTS_PER_RUN }),
        fc.array(operationArbitrary, { minLength: 10, maxLength: 30 }),
        async (openingBalances, operations) => {
          const wallet = await harness.createWallet();
          const accounts: ModelAccount[] = [];
          for (const opening of openingBalances) {
            const user = await harness.openUserAccount('NGN', accounts.length === 0 ? wallet : undefined);
            if (opening > 0n) await harness.fund(user, opening);
            accounts.push({ user, balance: opening, reserved: 0n });
          }
          const reservations: ModelReservation[] = [];
          // The controllable clock starts an hour ahead, so every expiry is in the database's future.
          const base = Date.now() + 60 * MINUTE;
          let clockMs = base;

          for (const operation of operations) {
            switch (operation.kind) {
              case 'reserve': {
                const model = steeredAccount(accounts, operation.account, operation.intoHold);
                const amountMinor = steeredAmount(model, operation.amountMinor, operation.intoHold);
                const refusal = expectedGate(model, amountMinor);
                const request = {
                  accountId: model.user.accountId,
                  flowId: nextFlowId(),
                  amount: Money.of(amountMinor, 'NGN'),
                  expiresAt: new Date(clockMs + operation.ttlMinutes * MINUTE),
                };
                if (refusal) {
                  await expectRefusedWithoutEffect(() => harness.reservations.reserve(request), refusal);
                  count(`reserve refused ${refusal}`);
                  break;
                }
                const held = await harness.reservations.reserve(request);
                model.reserved += amountMinor;
                reservations.push({
                  id: held.id,
                  flowId: request.flowId,
                  account: accounts.indexOf(model),
                  amountMinor,
                  expiresAtMs: request.expiresAt.getTime(),
                  status: ReservationStatus.ACTIVE,
                  settledMinor: null,
                  lastSeen: held,
                });
                count('reserved');
                break;
              }

              case 'reserveRetry': {
                if (reservations.length === 0) break;
                const target = reservations[operation.pick % reservations.length];
                const request = {
                  accountId: accounts[target.account].user.accountId,
                  flowId: target.flowId,
                  amount: Money.of(target.amountMinor + (operation.sameAmount ? 0n : 1n), 'NGN'),
                  expiresAt: new Date(clockMs + MINUTE),
                };
                if (operation.sameAmount) {
                  await expectRetryWithoutEffect(() => harness.reservations.reserve(request), target.lastSeen);
                  count(`reserve retried on ${target.status}`);
                } else {
                  await expectRefusedWithoutEffect(() => harness.reservations.reserve(request), ErrorCode.RESERVATION_CONFLICT);
                  count('reserve retry conflict');
                }
                break;
              }

              case 'settle':
              case 'settleRetry': {
                const candidates =
                  operation.kind === 'settle' ? reservations : reservations.filter((r) => r.status === ReservationStatus.SETTLED);
                if (candidates.length === 0) break;
                const target = candidates[operation.pick % candidates.length];
                const model = accounts[target.account];
                let actualMinor: bigint;
                if (operation.kind === 'settleRetry') {
                  actualMinor = (target.settledMinor as bigint) + (operation.sameAmount ? 0n : 1n);
                } else if (operation.relation === 'less') {
                  actualMinor = target.amountMinor > operation.deltaMinor ? target.amountMinor - operation.deltaMinor : 1n;
                } else if (operation.relation === 'equal') {
                  actualMinor = target.amountMinor;
                } else {
                  actualMinor = target.amountMinor + operation.deltaMinor;
                }
                const settle = () => harness.reservations.settle(target.id, spend(model.user, actualMinor));

                if (target.status === ReservationStatus.RELEASED) {
                  await expectRefusedWithoutEffect(settle, ErrorCode.RESERVATION_NOT_ACTIVE);
                  count('settle after release refused');
                } else if (target.status === ReservationStatus.SETTLED) {
                  if (actualMinor === target.settledMinor) {
                    await expectRetryWithoutEffect(settle, target.lastSeen);
                    count('settle retry replayed');
                  } else {
                    await expectRefusedWithoutEffect(settle, ErrorCode.RESERVATION_CONFLICT);
                    count('settle retry conflict');
                  }
                } else {
                  const wasActive = target.status === ReservationStatus.ACTIVE;
                  const settled = await settle();
                  if (wasActive) model.reserved -= target.amountMinor;
                  model.balance -= actualMinor;
                  target.status = ReservationStatus.SETTLED;
                  target.settledMinor = actualMinor;
                  target.lastSeen = settled;
                  expect(settled.settledAmount?.amountMinor).toBe(actualMinor);
                  count(wasActive ? `settled ${actualMinor < target.amountMinor ? 'less' : actualMinor === target.amountMinor ? 'equal' : 'more'}` : 'settled late');
                }
                break;
              }

              case 'release': {
                if (reservations.length === 0) break;
                const target = reservations[operation.pick % reservations.length];
                if (target.status !== ReservationStatus.ACTIVE) {
                  await expectRetryWithoutEffect(() => harness.reservations.release(target.id), target.lastSeen);
                  count(`release no-op on ${target.status}`);
                  break;
                }
                target.lastSeen = await harness.reservations.release(target.id);
                target.status = ReservationStatus.RELEASED;
                accounts[target.account].reserved -= target.amountMinor;
                count('released');
                break;
              }

              case 'expire': {
                clockMs += operation.advanceMinutes * MINUTE;
                const { expired } = await harness.reservations.expireDue(new Date(clockMs), 100_000);
                const expiredIds = new Set(expired.map((reservation) => reservation.id));
                for (const target of reservations) {
                  const due = target.status === ReservationStatus.ACTIVE && target.expiresAtMs <= clockMs;
                  expect({ id: target.id, expired: expiredIds.has(target.id) }).toEqual({ id: target.id, expired: due });
                  if (!due) continue;
                  target.status = ReservationStatus.EXPIRED;
                  target.lastSeen = expired.find((reservation) => reservation.id === target.id) as Reservation;
                  accounts[target.account].reserved -= target.amountMinor;
                  count('expired');
                }
                break;
              }

              case 'userDebit': {
                const model = steeredAccount(accounts, operation.account, operation.intoHold);
                const amountMinor = steeredAmount(model, operation.amountMinor, operation.intoHold);
                const refusal = expectedGate(model, amountMinor);
                if (refusal) {
                  await expectRefusedWithoutEffect(() => debit(model.user, amountMinor, PostingAuthorization.USER_INITIATED), refusal);
                  count(`user debit refused ${refusal}`);
                  break;
                }
                // A user-initiated spend never succeeds beyond available + overdraft limit (0).
                expect(amountMinor <= model.balance - model.reserved).toBe(true);
                await debit(model.user, amountMinor, PostingAuthorization.USER_INITIATED);
                model.balance -= amountMinor;
                count('user debit');
                break;
              }

              case 'systemDebit': {
                const model = accounts[operation.account];
                await debit(model.user, operation.amountMinor, PostingAuthorization.SYSTEM_DRIVEN);
                model.balance -= operation.amountMinor;
                if (model.balance < 0n) count('went negative');
                break;
              }

              case 'fund': {
                const model = accounts[operation.account];
                await harness.fund(model.user, operation.amountMinor);
                model.balance += operation.amountMinor;
                break;
              }
            }

            // After EVERY step: all §8.1 invariants (incl. reserved = Σ ACTIVE), then the model.
            await harness.expectCleanBooks();
            const { rows: accountRows } = await owner.query(
              `SELECT id, balance_minor::text AS balance, reserved_minor::text AS reserved FROM accounts WHERE id = ANY($1::uuid[])`,
              [accounts.map((model) => model.user.accountId)],
            );
            const byId = new Map((accountRows as { id: string; balance: string; reserved: string }[]).map((row) => [row.id, row]));
            for (const model of accounts) {
              const row = byId.get(model.user.accountId) as { balance: string; reserved: string };
              expect({ balance: BigInt(row.balance), reserved: BigInt(row.reserved) }).toEqual({ balance: model.balance, reserved: model.reserved });
              expect(BigInt(row.reserved) >= 0n).toBe(true);
            }
            if (reservations.length > 0) {
              const { rows } = await owner.query(
                `SELECT id, status, settled_minor::text AS settled FROM reservations WHERE id = ANY($1::uuid[]) ORDER BY reservations.id`,
                [reservations.map((reservation) => reservation.id)],
              );
              expect(rows).toEqual(
                reservations
                  .map((reservation) => ({ id: reservation.id, status: reservation.status, settled: reservation.settledMinor?.toString() ?? null }))
                  .sort((left, right) => (left.id < right.id ? -1 : 1)),
              );
              const overdue = await harness.reservationChecks.findOverdueReservations(new Date(clockMs));
              const ours = new Set(reservations.map((reservation) => reservation.id));
              expect(overdue.filter((row) => ours.has(row.reservationId)).map((row) => row.reservationId).sort()).toEqual(
                reservations.filter((r) => r.status === ReservationStatus.ACTIVE && r.expiresAtMs <= clockMs).map((r) => r.id).sort(),
              );
            }
          }

          // Leave no hold behind for later runs' sweeps.
          for (const target of reservations) if (target.status === ReservationStatus.ACTIVE) await harness.reservations.release(target.id);
        },
      ),
      { numRuns: 40 },
    );
    console.info('reservation property paths exercised', counts);

    // The generator must actually have exercised the interesting paths.
    for (const path of [
      'reserved',
      'reserve refused FUNDS_RESERVED',
      'reserve refused INSUFFICIENT_FUNDS',
      'reserve retry conflict',
      'settled less',
      'settled equal',
      'settled more',
      'settled late',
      'settle retry replayed',
      'settle retry conflict',
      'settle after release refused',
      'released',
      'release no-op on SETTLED',
      'release no-op on RELEASED',
      'release no-op on EXPIRED',
      'expired',
      'user debit',
      'user debit refused FUNDS_RESERVED',
      'user debit refused INSUFFICIENT_FUNDS',
      'went negative',
    ]) {
      expect({ path, seen: (counts[path] ?? 0) > 0 }).toEqual({ path, seen: true });
    }
  });
});
