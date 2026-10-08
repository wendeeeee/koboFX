import fc from 'fast-check';
import { DomainError } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import { ApprovalRequest } from '../../src/modules/admin/approvals/approval.service';
import { Approval, ApprovalActionType, ApprovalStatus } from '../../src/modules/admin/approvals/approval.types';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { UserRole, UserStatus } from '../../src/modules/users/user.types';
import { AdminHarness, LedgerHarness, PaymentsHarness, SignedUpUser, startLedgerHarness } from '../support/ledger-harness';

/**
 * For ANY interleaving of requests, approvals, rejections, cancellations, break-glass uses, role grants and revokes
 * and suspensions by several actors (Phase 10 plan §H):
 *  - nothing executes without a different, eligible approver — except break-glass, always flagged and paged;
 *  - nothing executes twice;
 *  - every executed write-off is exactly one posting, `approval:{id}`, linked back to it; no write-off without one;
 *  - the books are clean — after EVERY step, not only at the end.
 * A model tracks each actor's role and status; any decision the service accepts must be one the model says was
 * allowed (soundness). A fixed prelude walks every path in every run, asserted per run.
 */
describe('Admin properties (integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let admin: AdminHarness;
  let actors: { A: SignedUpUser; B: SignedUpUser; C: SignedUpUser; S: SignedUpUser };

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { payments: true });
    payments = harness.payments!;
    admin = payments.admin;
    const first = await admin.bootstrap();
    actors = {
      A: first.admin,
      S: first.security,
      B: await admin.grant('ADMIN', first.admin, first.security),
      C: await admin.grant('ADMIN', first.admin, first.security),
    };
  }, 180_000);

  afterAll(async () => harness?.close());

  interface Person {
    role: UserRole;
    status: UserStatus;
  }

  type Operation =
    | { kind: 'request'; actor: number; action: 'SUSPEND' | 'REINSTATE' | 'WRITE_OFF'; target: number; amount: number; breakGlass: boolean }
    | { kind: 'approve' | 'reject' | 'cancel'; actor: number; pick: number }
    | { kind: 'grant' | 'revoke' };

  const operation: fc.Arbitrary<Operation> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('request' as const), actor: fc.nat(4), action: fc.constantFrom('SUSPEND' as const, 'REINSTATE' as const, 'WRITE_OFF' as const), target: fc.nat(3), amount: fc.integer({ min: 1, max: 60_000 }), breakGlass: fc.boolean() }) },
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('approve' as const), actor: fc.nat(4), pick: fc.nat(20) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constantFrom('reject' as const, 'cancel' as const), actor: fc.nat(4), pick: fc.nat(20) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constantFrom('grant' as const, 'revoke' as const) }) },
  );

  async function invariants(): Promise<void> {
    const [violations] = (await harness.dataSource.query(`
      SELECT
        (SELECT count(*) FROM approvals WHERE status IN ('EXECUTED', 'EXECUTION_FAILED') AND NOT is_break_glass
            AND (approved_by IS NULL OR approved_by = requested_by OR executed_by IS DISTINCT FROM approved_by))::int AS without_second_person,
        (SELECT count(*) FROM approvals WHERE status IN ('EXECUTED', 'EXECUTION_FAILED') AND is_break_glass
            AND (approved_by IS NOT NULL OR NOT EXISTS (SELECT 1 FROM outbox_events WHERE event_type = 'BreakGlassUsed.v1' AND aggregate_id = approvals.id)))::int AS break_glass_unflagged,
        (SELECT count(*) FROM (SELECT subject_id FROM audit_logs WHERE action = 'APPROVAL_EXECUTED' GROUP BY subject_id HAVING count(*) > 1) twice)::int AS executed_twice,
        (SELECT count(*) FROM approvals WHERE action_type = 'WRITE_OFF' AND status = 'EXECUTED'
            AND (SELECT count(*) FROM transactions WHERE transactions.reference = 'approval:' || approvals.id::text AND transactions.type = 'WRITE_OFF'
                   AND transactions.metadata ->> 'approvalId' = approvals.id::text AND transactions.id::text = approvals.result_reference) <> 1)::int AS unlinked_write_offs,
        (SELECT count(*) FROM transactions WHERE type = 'WRITE_OFF' AND NOT EXISTS (
            SELECT 1 FROM approvals WHERE approvals.status = 'EXECUTED' AND 'approval:' || approvals.id::text = transactions.reference))::int AS write_offs_without_approval
    `)) as Record<string, number>[];
    expect(violations).toEqual({ without_second_person: 0, break_glass_unflagged: 0, executed_twice: 0, unlinked_write_offs: 0, write_offs_without_approval: 0 });
    await harness.expectCleanBooks();
  }

  it('four-eyes, once, linked, clean — after every step of any interleaving', async () => {
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 10, maxLength: 22 }), async (tail) => {
        run += 1;
        const seen = new Set<string>();
        // This run's people: three targets, a debtor overdrawn by ₦1,000, and a spare user whose role comes and goes.
        const targets = [await payments.signUp(), await payments.signUp(), await payments.signUp()];
        const debtor = await payments.signUp();
        const spare = await payments.signUp();
        const [account] = (await harness.dataSource.query(
          `SELECT accounts.id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id WHERE wallets.user_id = $1 AND accounts.currency_code = 'NGN'`,
          [debtor.userId],
        )) as { id: string }[];
        await harness.ledger.post({
          transaction: { type: TransactionType.WITHDRAWAL, authorization: PostingAuthorization.SYSTEM_DRIVEN, valueTime: new Date(), initiatedBy: 'job:test', userId: debtor.userId },
          entries: [
            { account: { accountId: account!.id }, direction: EntryDirection.DEBIT, amount: Money.of(100_000n, 'NGN') },
            { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(100_000n, 'NGN') },
          ],
        });

        const people = new Map<string, Person>([
          [actors.A.userId, { role: UserRole.ADMIN, status: UserStatus.ACTIVE }],
          [actors.B.userId, { role: UserRole.ADMIN, status: UserStatus.ACTIVE }],
          [actors.C.userId, { role: UserRole.ADMIN, status: UserStatus.ACTIVE }],
          [actors.S.userId, { role: UserRole.SECURITY, status: UserStatus.ACTIVE }],
          [spare.userId, { role: UserRole.USER, status: UserStatus.ACTIVE }],
          ...targets.map((target) => [target.userId, { role: UserRole.USER, status: UserStatus.ACTIVE }] as [string, Person]),
        ]);
        const cast = [actors.A, actors.B, actors.C, actors.S, spare];
        const eligible = (userId: string, role: UserRole) => people.get(userId)?.role === role && people.get(userId)?.status === UserStatus.ACTIVE;
        const approvals: Approval[] = [];

        const record = (label: string) => seen.add(label);
        const attempt = async (label: string, work: () => Promise<Approval>): Promise<Approval | null> => {
          try {
            const result = await work();
            record(`${label}:${result.status}${result.isBreakGlass ? ':BREAK_GLASS' : ''}`);
            return result;
          } catch (error) {
            if (!(error instanceof DomainError) || error.httpStatus >= 500) throw error;
            record(`${label}:${error.code}`);
            return null;
          }
        };
        /** Apply what an executed approval did to the model. */
        const applied = (approval: Approval) => {
          if (approval.status !== ApprovalStatus.EXECUTED) return;
          const payload = approval.payload as { userId: string; role?: UserRole; operation?: string };
          const person = people.get(payload.userId);
          if (!person) return;
          if (approval.actionType === ApprovalActionType.SUSPEND_USER) person.status = UserStatus.SUSPENDED;
          if (approval.actionType === ApprovalActionType.REINSTATE_USER) person.status = UserStatus.ACTIVE;
          if (approval.actionType === ApprovalActionType.ROLE_CHANGE) person.role = payload.operation === 'GRANT' ? (payload.role as UserRole) : UserRole.USER;
        };
        const requestAs = (actor: SignedUpUser, request: ApprovalRequest) => attempt('request', () => admin.approvals.request(actor.userId, request));
        const decide = async (decision: 'approve' | 'reject' | 'cancel', actor: SignedUpUser, approval: Approval) => {
          const before = new Map([...people].map(([id, person]) => [id, { ...person }]));
          const result = await attempt(decision, () =>
            decision === 'approve'
              ? admin.approvals.approve(approval.id, actor.userId)
              : decision === 'reject'
                ? admin.approvals.reject(approval.id, actor.userId, 'no')
                : admin.approvals.cancel(approval.id, actor.userId),
          );
          if (result && (decision === 'approve' || decision === 'reject')) {
            // Soundness: the service only accepts what the model says was allowed at that moment.
            const deciderRole = approval.actionType === ApprovalActionType.ROLE_CHANGE ? UserRole.SECURITY : UserRole.ADMIN;
            expect(actor.userId).not.toBe(approval.requestedBy);
            expect(before.get(actor.userId)?.role === deciderRole && before.get(actor.userId)?.status === UserStatus.ACTIVE).toBe(true);
            expect(before.get(approval.requestedBy)?.role === UserRole.ADMIN && before.get(approval.requestedBy)?.status === UserStatus.ACTIVE).toBe(true);
          }
          if (result) {
            applied(result);
            approvals[approvals.indexOf(approval)] = result;
          }
          await invariants();
        };
        const suspend = (userId: string): ApprovalRequest => ({ actionType: ApprovalActionType.SUSPEND_USER, payload: { userId }, reason: 'property', breakGlass: false });
        const writeOff = (amount: number): ApprovalRequest => ({
          actionType: ApprovalActionType.WRITE_OFF,
          payload: { userId: debtor.userId, currency: 'NGN', amount: String(amount), valueTime: new Date(Date.now() - 1000).toISOString() },
          reason: 'property',
          breakGlass: false,
        });
        const roleChange = (operation: 'GRANT' | 'REVOKE'): ApprovalRequest => ({
          actionType: ApprovalActionType.ROLE_CHANGE,
          payload: { userId: spare.userId, role: 'ADMIN', operation },
          reason: 'property',
          breakGlass: false,
        });
        const push = async (approval: Approval | null) => {
          if (approval) {
            approvals.push(approval);
            applied(approval);
          }
          await invariants();
          return approval;
        };

        // ── the prelude: every path, every run ──
        const suspension = (await push(await requestAs(actors.A, suspend(targets[0]!.userId))))!;
        await decide('approve', actors.A, suspension); // SELF_APPROVAL_FORBIDDEN
        await decide('approve', actors.S, suspension); // FORBIDDEN (security on a money-side action)
        await decide('approve', actors.B, suspension); // EXECUTED
        await decide('approve', actors.C, approvals[approvals.length - 1]!); // APPROVAL_ALREADY_DECIDED
        await decide('reject', actors.C, (await push(await requestAs(actors.A, { ...suspend(targets[0]!.userId), actionType: ApprovalActionType.REINSTATE_USER })))!);
        await decide('cancel', actors.A, (await push(await requestAs(actors.A, { ...suspend(targets[0]!.userId), actionType: ApprovalActionType.REINSTATE_USER })))!);
        await decide('approve', actors.B, (await push(await requestAs(actors.A, writeOff(10_000))))!); // posted
        const first = (await push(await requestAs(actors.A, writeOff(60_000))))!;
        const second = (await push(await requestAs(actors.C, writeOff(60_000))))!;
        await decide('approve', actors.B, first); // fits
        await decide('approve', actors.B, second); // no longer fits: EXECUTION_FAILED
        await push(await requestAs(actors.C, { ...suspend(targets[1]!.userId), breakGlass: true })); // break-glass
        await decide('approve', actors.S, (await push(await requestAs(actors.A, roleChange('GRANT'))))!);
        const bySpare = (await push(await requestAs(spare, suspend(targets[2]!.userId))))!;
        await decide('approve', actors.S, (await push(await requestAs(actors.A, roleChange('REVOKE'))))!);
        await decide('approve', actors.B, bySpare); // APPROVAL_REQUESTER_INELIGIBLE
        for (const path of [
          'approve:SELF_APPROVAL_FORBIDDEN',
          'approve:FORBIDDEN',
          'approve:EXECUTED',
          'approve:APPROVAL_ALREADY_DECIDED',
          'reject:REJECTED',
          'cancel:CANCELLED',
          'approve:EXECUTION_FAILED',
          'request:EXECUTED:BREAK_GLASS',
          'approve:APPROVAL_REQUESTER_INELIGIBLE',
        ]) {
          expect({ run, path, seen: seen.has(path) }).toEqual({ run, path, seen: true });
        }

        // ── the generated tail ──
        for (const step of tail) {
          if (step.kind === 'request') {
            const actor = cast[step.actor]!;
            const target = [...targets, spare][step.target]!;
            const request: ApprovalRequest =
              step.action === 'WRITE_OFF'
                ? writeOff(step.amount)
                : { ...suspend(target.userId), actionType: step.action === 'SUSPEND' ? ApprovalActionType.SUSPEND_USER : ApprovalActionType.REINSTATE_USER, breakGlass: step.action === 'SUSPEND' && step.breakGlass };
            const result = await push(await requestAs(actor, request));
            if (result?.isBreakGlass) expect(eligible(actor.userId, UserRole.ADMIN) || result.status !== ApprovalStatus.EXECUTED).toBe(true);
          } else if (step.kind === 'grant' || step.kind === 'revoke') {
            const change = await push(await requestAs(actors.A, roleChange(step.kind === 'grant' ? 'GRANT' : 'REVOKE')));
            if (change) await decide('approve', actors.S, change);
          } else if ('pick' in step && approvals.length > 0) {
            await decide(step.kind, cast[step.actor]!, approvals[step.pick % approvals.length]!);
          }
        }
      }),
      { numRuns: 4, interruptAfterTimeLimit: 8 * 60_000, markInterruptAsFailure: true },
    );
  }, 15 * 60_000);
});
