import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import request from 'supertest';
import { API_PREFIX } from '../../src/app.setup';
import { FlowCheckpoint } from '../../src/modules/flows/flow.types';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { InjectedCrash } from '../support/flow-test-doubles';
import { LedgerHarness, PaymentsHarness, PaystackHarness, SignedUpUser, WithdrawalsHarness, startLedgerHarness } from '../support/ledger-harness';

const ACCOUNT_NUMBER = '0123456789';
const FUNDED = 1_000_000n;

/** What Paystack says about a transfer (the model's truth), independent of what we recorded. */
type ProviderTruth = 'UNSENT' | 'PENDING' | 'SUCCESS' | 'FAILED' | 'REVERSED';
/** What the model expects us to have recorded. */
type Local = 'HELD' | 'POSTED' | 'FAILED' | 'REVERSED';

interface ModelWithdrawal {
  readonly id: string;
  readonly key: string;
  readonly amount: bigint;
  readonly accepted: { status: number; body: unknown };
  provider: ProviderTruth;
  local: Local;
  /** A signed `transfer.reversed` hint is queued at the mock (delivered by a settle that delivers webhooks). */
  reversalHint: boolean;
}

type Command =
  | { kind: 'admit'; amount: bigint }
  | { kind: 'replay'; pick: number }
  | { kind: 'succeed' | 'fail' | 'reverse'; pick: number; emit: boolean }
  | { kind: 'settle'; deliverWebhooks: boolean }
  | { kind: 'crashThenSettle' }
  | { kind: 'reconcile' };

const AMOUNTS = [10_000n, 120_000n, 300_000n, 650_000n, 1_200_000n];
const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...AMOUNTS).map((amount) => ({ kind: 'admit' as const, amount })) },
  { weight: 1, arbitrary: fc.nat(20).map((pick) => ({ kind: 'replay' as const, pick })) },
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constantFrom('succeed' as const, 'fail' as const, 'reverse' as const), pick: fc.nat(20), emit: fc.boolean() }),
  },
  { weight: 3, arbitrary: fc.boolean().map((deliverWebhooks) => ({ kind: 'settle' as const, deliverWebhooks })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'crashThenSettle' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'reconcile' as const }) },
);

/** Narrow paths every run walks first (generated tails explore from there). */
const PRELUDE: Command[] = [
  { kind: 'admit', amount: 300_000n }, // #0
  { kind: 'settle', deliverWebhooks: false }, // sent, pending
  { kind: 'succeed', pick: 0, emit: true },
  { kind: 'settle', deliverWebhooks: true }, // #0 POSTED (a hint delivered AND the resumer)
  { kind: 'reverse', pick: 0, emit: false },
  { kind: 'reconcile' }, // #0 REVERSED with no webhook
  { kind: 'admit', amount: 120_000n }, // #1
  { kind: 'settle', deliverWebhooks: false },
  { kind: 'fail', pick: 1, emit: false },
  { kind: 'crashThenSettle' }, // #1 FAILED after a crash
  { kind: 'admit', amount: 650_000n }, // #2 held
  { kind: 'admit', amount: 650_000n }, // FUNDS_RESERVED (the total would cover it)
  { kind: 'admit', amount: 1_200_000n }, // INSUFFICIENT_FUNDS
  { kind: 'replay', pick: 2 },
  { kind: 'settle', deliverWebhooks: false },
];

/**
 * W4 — an INDEPENDENT model of withdrawals (WITHDRAWAL_PLAN.md §L.2). It knows only the product rules: a hold at
 * admission (FUNDS_RESERVED vs INSUFFICIENT_FUNDS by the gate's rule), money leaves the wallet only when Paystack's
 * truth is success, a definitive failure returns the hold, a full return after success reverses principal and stash,
 * and a replayed key changes nothing. It does not reuse the implementation's transition tables. After EVERY step —
 * before any eventual success too — the database must agree: wallet balance and reserve, stash net, exact books per
 * currency, receipts only from matched verified successes, one posting/receipt/transfer at most per withdrawal, and
 * the wallet's available never includes the stash.
 */
describe('Withdrawal properties (W4, integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  let withdrawals: WithdrawalsHarness;
  let periodSequence = 0;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { paystack: { withdrawals: true } });
    payments = harness.payments!;
    paystack = payments.paystack!;
    withdrawals = paystack.withdrawals!;
    paystack.mock.transfers.addAccount('058', ACCOUNT_NUMBER, 'ADA LOVELACE');
    paystack.mock.transfers.setBalance(10n ** 15n);
  }, 180_000);
  afterAll(async () => harness?.close());

  const http = () => request(harness.auth!.app.getHttpServer());
  const scalar = async (sql: string, parameters: unknown[]) => ((await harness.dataSource.query(sql, parameters)) as { value: string }[])[0].value;

  it('the model and the database agree after every step of any interleaving', async () => {
    const seen = new Set<string>();
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 4, maxLength: 12 }), async (tail) => {
        await payments.clearRateLimits();
        await withdrawals.beat();
        paystack.mock.clearFaults();
        paystack.mock.dropWebhooks();
        payments.checkpoints.disarm();
        const user: SignedUpUser = await payments.signUp();
        const [account] = (await harness.dataSource.query(
          `SELECT accounts.id, wallets.id AS wallet_id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
            WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
          [user.userId],
        )) as { id: string; wallet_id: string }[];
        await harness.fund({ userId: user.userId, walletId: account.wallet_id, accountId: account.id, currency: 'NGN' }, FUNDED);
        const added = await withdrawals.addBeneficiary(user, { bankCode: '058', accountNumber: ACCOUNT_NUMBER, currency: 'NGN' });
        const beneficiaryId = (added.body as { beneficiaryId: string }).beneficiaryId;
        await payments.drive({ deliverWebhooks: false });

        const model = { balance: FUNDED, reserved: 0n, stash: 0n, withdrawals: [] as ModelWithdrawal[] };
        const pick = (index: number) => (model.withdrawals.length === 0 ? undefined : model.withdrawals[index % model.withdrawals.length]);

        /** What the system must have done once it looked at every transfer (the model's rules, not the code's). */
        const settleModel = (applyReversals: 'none' | 'hinted' | 'all') => {
          for (const each of model.withdrawals) {
            if (each.provider === 'UNSENT') each.provider = 'PENDING'; // every admitted transfer is sent (pending by script)
            if (each.local === 'HELD' && each.provider === 'SUCCESS') {
              each.local = 'POSTED';
              model.reserved -= each.amount;
              model.balance -= each.amount;
              model.stash += each.amount;
            } else if (each.local === 'HELD' && each.provider === 'FAILED') {
              each.local = 'FAILED';
              model.reserved -= each.amount;
            } else if (each.local === 'POSTED' && each.provider === 'REVERSED' && (applyReversals === 'all' || (applyReversals === 'hinted' && each.reversalHint))) {
              each.local = 'REVERSED';
              model.balance += each.amount;
              model.stash -= each.amount;
            }
          }
        };
        const settle = async (deliverWebhooks: boolean) => {
          await payments.makeAllDue();
          await payments.drive({ deliverWebhooks });
          settleModel(deliverWebhooks ? 'hinted' : 'none');
          if (deliverWebhooks) for (const each of model.withdrawals) if (each.local === 'REVERSED') each.reversalHint = false;
        };

        const check = async (label: string) => {
          seen.add(label);
          expect({ label, balance: await harness.balanceOf(account.id) }).toEqual({ label, balance: model.balance });
          expect({ label, reserved: await harness.reservedOf(account.id) }).toEqual({ label, reserved: model.reserved });
          const stash = BigInt(
            await scalar(
              `SELECT coalesce(sum(CASE event_kind WHEN 'CONFIRMATION' THEN amount_minor ELSE -amount_minor END), 0)::text AS value FROM stash_receipts WHERE user_id = $1`,
              [user.userId],
            ),
          );
          expect({ label, stash }).toEqual({ label, stash: model.stash });
          for (const each of model.withdrawals) {
            const [row] = (await harness.dataSource.query(
              `SELECT flow_instances.state,
                      (SELECT count(*) FROM transactions WHERE reference = 'withdrawal:' || paystack_withdrawals.flow_id::text)::int AS principals,
                      (SELECT count(*) FROM transactions WHERE reference = 'withdrawal-reversal:' || paystack_withdrawals.flow_id::text)::int AS reversals,
                      coalesce((SELECT string_agg(event_kind::text, ',' ORDER BY event_kind) FROM stash_receipts WHERE withdrawal_id = paystack_withdrawals.flow_id), '') AS receipts
                 FROM paystack_withdrawals JOIN flow_instances ON flow_instances.id = paystack_withdrawals.flow_id WHERE paystack_withdrawals.flow_id = $1`,
              [each.id],
            )) as { state: string; principals: number; reversals: number; receipts: string }[];
            const expected = {
              HELD: { states: ['RESERVED', 'SUBMITTING', 'PROCESSING'], principals: 0, reversals: 0, receipts: '' },
              POSTED: { states: ['POSTED'], principals: 1, reversals: 0, receipts: 'CONFIRMATION' },
              FAILED: { states: ['FAILED'], principals: 0, reversals: 0, receipts: '' },
              REVERSED: { states: ['REVERSED'], principals: 1, reversals: 1, receipts: 'CONFIRMATION,REVERSAL' },
            }[each.local];
            expect({ label, id: each.id, state: expected.states.includes(row.state) ? 'ok' : row.state }).toEqual({ label, id: each.id, state: 'ok' });
            expect({ label, id: each.id, principals: row.principals, reversals: row.reversals, receipts: row.receipts }).toEqual({
              label,
              id: each.id,
              principals: expected.principals,
              reversals: expected.reversals,
              receipts: expected.receipts,
            });
            expect(paystack.mock.transfers.transfersFor(`withdrawal-${each.id}`)).toBeLessThanOrEqual(1);
          }
          // A receipt only from a matched, verified success (transfer.verify), never from a webhook or a list.
          expect(
            Number(
              await scalar(
                `SELECT count(*)::text AS value FROM stash_receipts r
                   JOIN withdrawal_verifications v ON v.id = r.verification_id
                   JOIN paystack_transfer_observations o ON o.id = v.observation_id
                  WHERE r.user_id = $1 AND r.event_kind = 'CONFIRMATION' AND (v.outcome::text <> 'SUCCESS' OR o.operation <> 'transfer.verify')`,
                [user.userId],
              ),
            ),
          ).toBe(0);
          // The stash is never spendable: the wallet's available is balance − reserved, nothing more.
          const wallet = await http().get(`${API_PREFIX}/wallet`).set('Authorization', `Bearer ${user.accessToken}`);
          const ngn = (wallet.body.balances as { currency: string; available: string; total: string }[]).find((each) => each.currency === 'NGN')!;
          expect({ label, total: ngn.total, available: ngn.available }).toEqual({
            label,
            total: model.balance.toString(),
            available: (model.balance - model.reserved).toString(),
          });
          await harness.expectCleanBooks();
        };

        const apply = async (step: Command) => {
          switch (step.kind) {
            case 'admit': {
              const key = randomUUID();
              const response = await withdrawals.withdraw(user, { beneficiaryId, amount: step.amount.toString(), currency: 'NGN' }, key);
              const available = model.balance - model.reserved;
              if (step.amount <= available) {
                expect(response.status).toBe(202);
                const id = (response.body as { withdrawalId: string }).withdrawalId;
                model.withdrawals.push({ id, key, amount: step.amount, accepted: { status: response.status, body: response.body }, provider: 'UNSENT', local: 'HELD', reversalHint: false });
                model.reserved += step.amount;
                return 'admit:ADMITTED';
              }
              // The gate's rule: the TOTAL would cover it but holds are in the way ⇒ FUNDS_RESERVED.
              const code = model.reserved > 0n && step.amount <= model.balance ? 'FUNDS_RESERVED' : 'INSUFFICIENT_FUNDS';
              expect({ status: response.status, code: (response.body as { code: string }).code }).toEqual({ status: 409, code });
              return `admit:${code}`;
            }
            case 'replay': {
              const target = pick(step.pick);
              if (!target) return 'replay:none';
              const before = await harness.snapshot();
              const again = await withdrawals.withdraw(user, { beneficiaryId, amount: target.amount.toString(), currency: 'NGN' }, target.key);
              expect({ status: again.status, body: again.body }).toEqual(target.accepted);
              expect(again.headers['idempotent-replayed']).toBe('true');
              const after = await harness.snapshot();
              expect([after.transactionCount, after.accountsDigest, after.reservationsDigest, after.flowCount]).toEqual([
                before.transactionCount,
                before.accountsDigest,
                before.reservationsDigest,
                before.flowCount,
              ]);
              return 'replay:NO_EFFECT';
            }
            case 'succeed':
            case 'fail': {
              const target = pick(step.pick);
              if (!target || target.provider !== 'PENDING') return `${step.kind}:skipped`;
              target.provider = step.kind === 'succeed' ? 'SUCCESS' : 'FAILED';
              paystack.mock.transfers.setTransferStatus(`withdrawal-${target.id}`, step.kind === 'succeed' ? 'success' : 'failed', { emit: step.emit });
              return `${step.kind}:${step.emit ? 'hinted' : 'silent'}`;
            }
            case 'reverse': {
              const target = pick(step.pick);
              if (!target || target.local !== 'POSTED' || target.provider !== 'SUCCESS') return 'reverse:skipped';
              target.provider = 'REVERSED';
              target.reversalHint = step.emit;
              paystack.mock.transfers.setTransferStatus(`withdrawal-${target.id}`, 'reversed', { emit: step.emit });
              return `reverse:${step.emit ? 'hinted' : 'silent'}`;
            }
            case 'settle':
              await settle(step.deliverWebhooks);
              return `settle:${step.deliverWebhooks}`;
            case 'crashThenSettle': {
              const fired = payments.checkpoints.arm({ state: 'PROCESSING', point: FlowCheckpoint.AFTER_EXTERNAL_CALL, mode: 'throw' });
              void fired;
              await payments.makeAllDue();
              try {
                await payments.drive({ deliverWebhooks: false });
              } catch (error) {
                if (!(error instanceof InjectedCrash)) throw error;
              }
              const crashed = payments.checkpoints.hasFired;
              payments.checkpoints.disarm();
              await settle(false);
              return `crash:${crashed ? 'fired' : 'idle'}`;
            }
            case 'reconcile': {
              for (const kind of [ReconciliationRunKind.EXTERNAL_HOURLY, ReconciliationRunKind.EXTERNAL_DAILY]) {
                periodSequence += 1;
                await payments.reconciliation.scheduler.runPeriod(kind, `${4000 + periodSequence}-01-01${kind === ReconciliationRunKind.EXTERNAL_HOURLY ? 'T00' : ''}`, 'paystack');
              }
              await payments.makeAllDue();
              await payments.drive({ deliverWebhooks: false });
              settleModel('all');
              return 'reconcile';
            }
          }
        };

        // The script: every created transfer starts pending; the commands move Paystack's truth.
        paystack.mock.transfers.setNextTransfer({ status: 'pending', fee: 1_000n, domain: 'test' });
        await check('start');
        for (const step of [...PRELUDE, ...tail]) {
          await payments.clearRateLimits(); // HTTP abuse limits must not conceal (or fake) a money outcome
          const label = await apply(step);
          await check(label);
        }
      }),
      { numRuns: 5, endOnFailure: true },
    );
    // The prelude guarantees the narrow paths ran (the tails explore beyond them).
    for (const label of ['admit:ADMITTED', 'admit:FUNDS_RESERVED', 'admit:INSUFFICIENT_FUNDS', 'replay:NO_EFFECT', 'reconcile', 'crash:fired', 'reverse:silent']) {
      expect([...seen]).toContain(label);
    }
  }, 40 * 60_000);
});
