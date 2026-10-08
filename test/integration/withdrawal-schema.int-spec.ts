import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import {
  PAYSTACK_BENEFICIARY_COMPLETION_STATES,
  PAYSTACK_BENEFICIARY_STATES,
  PAYSTACK_BENEFICIARY_TRANSITIONS,
} from '../../src/modules/flows/paystack-beneficiary/paystack-beneficiary-transitions';
import {
  PAYSTACK_WITHDRAWAL_COMPLETION_STATES,
  PAYSTACK_WITHDRAWAL_STATES,
  PAYSTACK_WITHDRAWAL_TRANSITIONS,
} from '../../src/modules/flows/paystack-withdrawal/paystack-withdrawal-transitions';
import { resolvePayoutAccounts } from '../../src/modules/withdrawals/withdrawal-accounts';
import { providerReferenceOf } from '../../src/modules/withdrawals/withdrawal-references';
import { LedgerHarness, startLedgerHarness, UserAccount } from '../support/ledger-harness';
import { AdmittedWithdrawal, PROVIDER_ACCOUNT_IDENTITY, WithdrawalFixtures } from '../support/withdrawal-fixtures';

/**
 * W1 schema (WITHDRAWAL_PLAN.md §D, §E, §F; D1–D9 approved 2026-10-03): the transition tables equal their SQL mirror
 * pair for pair; each state's facts are enforced at COMMIT; owners, currencies, principals and destinations are bound by
 * construction; evidence is immutable for every role; the application role cannot attach a receipt to inconsistent or
 * unposted facts. The money paths here use the real ReservationService and LedgerService.
 */
describe('Withdrawal schema guards', () => {
  let harness: LedgerHarness;
  let fixtures: WithdrawalFixtures;
  let app: Client;
  let owner: Client;
  let superuser: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness();
    fixtures = new WithdrawalFixtures(harness);
    [app, owner, superuser] = await Promise.all([harness.db.appClient(), harness.db.ownerClient(), harness.db.superuserClient()]);
  });
  afterAll(async () => {
    await Promise.all([app?.end(), owner?.end(), superuser?.end()]);
    await harness?.close();
  });

  const fundedAccount = async (amountMinor = 1_000_000n): Promise<UserAccount> => {
    const account = await harness.openUserAccount('NGN');
    await harness.fund(account, amountMinor);
    return account;
  };
  const admitted = async (principalMinor = 300_000n, account?: UserAccount): Promise<AdmittedWithdrawal> => {
    const funded = account ?? (await fundedAccount());
    const beneficiary = await fixtures.readyBeneficiary(funded.userId);
    return fixtures.admit(funded, beneficiary, principalMinor);
  };
  /** One explicit transaction on a raw client: deferred checks run at its COMMIT. */
  const transaction = async (client: Client, statements: Array<[string, unknown[]?]>) => {
    await client.query('BEGIN');
    try {
      for (const [sql, params] of statements) await client.query(sql, params);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };

  describe('state machines', () => {
    it('the SQL transition function agrees with both TypeScript tables on every pair; older flow types are untouched', async () => {
      const disagreements: string[] = [];
      for (const [type, states, table] of [
        ['PAYSTACK_WITHDRAWAL', PAYSTACK_WITHDRAWAL_STATES, PAYSTACK_WITHDRAWAL_TRANSITIONS],
        ['PAYSTACK_BENEFICIARY', PAYSTACK_BENEFICIARY_STATES, PAYSTACK_BENEFICIARY_TRANSITIONS],
      ] as const) {
        for (const from of states) {
          for (const to of states) {
            const { rows } = await app.query(`SELECT flow_transition_allowed($1, $2, $3) AS allowed`, [type, from, to]);
            const expected = (table as Record<string, readonly string[]>)[from].includes(to);
            if ((rows[0] as { allowed: boolean }).allowed !== expected) disagreements.push(`${type} ${from}→${to}`);
          }
        }
      }
      expect(disagreements).toEqual([]);
      const { rows } = await app.query(`
        SELECT flow_transition_allowed('FUNDING', 'INITIATED', 'AUTHORIZED') AS funding,
               flow_transition_allowed('CONVERSION', 'INITIATED', 'POSTED') AS conversion,
               flow_transition_allowed('PAYSTACK_FUNDING', 'CHECKOUT_READY', 'HELD') AS paystack_funding,
               flow_transition_allowed('PAYSTACK_WITHDRAWAL', 'RESERVED', 'POSTED') AS shortcut,
               flow_transition_allowed('PAYSTACK_WITHDRAWAL', 'FAILED', 'POSTED') AS recovery,
               flow_transition_allowed('FUNDING', 'RESERVED', 'SUBMITTING') AS crossed`);
      expect(rows[0]).toEqual({ funding: true, conversion: true, paystack_funding: true, shortcut: false, recovery: false, crossed: false });
    });

    it('states are CHECKed per type; READY joins the completion states', async () => {
      const { userId } = await harness.createWallet();
      await expect(
        app.query(`INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('PAYSTACK_WITHDRAWAL', 'INITIATED', $1)`, [userId]),
      ).rejects.toThrow(/flow_instances_state_valid/);
      await expect(
        app.query(`INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('PAYSTACK_BENEFICIARY', 'RESERVED', $1)`, [userId]),
      ).rejects.toThrow(/flow_instances_state_valid/);
      expect(PAYSTACK_BENEFICIARY_COMPLETION_STATES).toEqual(['READY', 'FAILED']);
      expect(PAYSTACK_WITHDRAWAL_COMPLETION_STATES).toEqual(['POSTED', 'FAILED', 'REVERSED']);
    });

    it('a withdrawal or beneficiary flow without its typed record cannot commit', async () => {
      const { userId } = await harness.createWallet();
      await expect(
        app.query(`INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('PAYSTACK_WITHDRAWAL', 'RESERVED', $1)`, [userId]),
      ).rejects.toThrow(/has no withdrawal/);
      await expect(
        app.query(`INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('PAYSTACK_BENEFICIARY', 'REQUESTED', $1)`, [userId]),
      ).rejects.toThrow(/has no beneficiary/);
    });
  });

  describe('beneficiaries', () => {
    it('READY requires a resolution and a validated recipient; identity is immutable; facts are set once', async () => {
      const { userId } = await harness.createWallet();
      const ready = await fixtures.readyBeneficiary(userId);
      await expect(
        app.query(`UPDATE withdrawal_beneficiaries SET bank_code = '011' WHERE id = $1`, [ready.beneficiaryId]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        owner.query(`UPDATE withdrawal_beneficiaries SET bank_code = '011' WHERE id = $1`, [ready.beneficiaryId]),
      ).rejects.toThrow(/immutable apart from its progression/);
      await expect(
        app.query(`UPDATE withdrawal_beneficiaries SET resolved_at = now() WHERE id = $1`, [ready.beneficiaryId]),
      ).rejects.toThrow(/set once/);
      await expect(app.query(`DELETE FROM withdrawal_beneficiaries WHERE id = $1`, [ready.beneficiaryId])).rejects.toThrow(
        /permission denied/,
      );

      // Skipping the recipient: READY without it fails at commit.
      const flow = await harness.unitOfWork.run(async (manager) => {
        const [created] = (await manager.query(
          `INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('PAYSTACK_BENEFICIARY', 'REQUESTED', $1) RETURNING id`,
          [userId],
        )) as { id: string }[];
        await manager.query(
          `INSERT INTO withdrawal_beneficiaries (user_id, flow_id, currency_code, bank_code, account_number_last_four,
             sealing_key_id, account_number_sealed, identity_fingerprint, identity_fingerprint_key_id, provider_account_identity)
           VALUES ($1, $2, 'NGN', '058', '1234', 'data-key-1', $3, $4, 'fingerprint-key-1', $5)`,
          [userId, created.id, randomBytes(40), randomBytes(32), PROVIDER_ACCOUNT_IDENTITY],
        );
        return created.id;
      });
      await expect(
        transaction(app, [
          [`UPDATE withdrawal_beneficiaries SET resolved_account_name_sealed = $2, resolution_evidence_id = $3, resolved_at = now() WHERE flow_id = $1`,
            [flow, randomBytes(40), await fixtures.evidence()]],
          [`UPDATE flow_instances SET state = 'RESOLVED' WHERE id = $1`, [flow]],
          [`UPDATE flow_instances SET state = 'CREATING' WHERE id = $1`, [flow]],
          [`UPDATE flow_instances SET state = 'READY', completed_at = now() WHERE id = $1`, [flow]],
        ]),
      ).rejects.toThrow(/READY without a validated recipient/);
      await expect(transaction(app, [[`UPDATE flow_instances SET state = 'RESOLVED' WHERE id = $1`, [flow]]])).rejects.toThrow(
        /has no resolution/,
      );
    });

    it('one beneficiary per (owner, keyed fingerprint); a flow of another type or owner cannot carry one', async () => {
      const { userId } = await harness.createWallet();
      const ready = await fixtures.readyBeneficiary(userId);
      const other = await harness.createWallet();
      const insert = (flowType: string, flowOwner: string, fingerprint: Buffer) =>
        transaction(app, [
          [`CREATE TEMP TABLE IF NOT EXISTS scratch (id uuid)`, []],
          [`TRUNCATE scratch`, []],
          [`WITH f AS (INSERT INTO flow_instances (flow_type, state, user_id) VALUES ($1, $2, $3) RETURNING id) INSERT INTO scratch SELECT id FROM f`,
            [flowType, flowType === 'PAYSTACK_BENEFICIARY' ? 'REQUESTED' : 'INITIATED', flowOwner]],
          [`INSERT INTO withdrawal_beneficiaries (user_id, flow_id, currency_code, bank_code, account_number_last_four, sealing_key_id,
              account_number_sealed, identity_fingerprint, identity_fingerprint_key_id, provider_account_identity)
            SELECT $1, id, 'NGN', '058', '1234', 'data-key-1', $2, $3, 'fingerprint-key-1', $4 FROM scratch`,
            [userId, randomBytes(40), fingerprint, PROVIDER_ACCOUNT_IDENTITY]],
        ]);
      await expect(insert('PAYSTACK_BENEFICIARY', userId, ready.fingerprint)).rejects.toThrow(/withdrawal_beneficiaries_identity_unique/);
      await expect(insert('PAYSTACK_FUNDING', userId, randomBytes(32))).rejects.toThrow(/PAYSTACK_BENEFICIARY flow/);
      await expect(insert('PAYSTACK_BENEFICIARY', other.userId, randomBytes(32))).rejects.toThrow(/PAYSTACK_BENEFICIARY flow/);
    });
  });

  describe('admission', () => {
    it('admits with a protected hold of the principal; the destination is frozen; the customer fee is zero', async () => {
      const account = await fundedAccount();
      const withdrawal = await admitted(300_000n, account);
      expect(await harness.reservedOf(account.accountId)).toBe(300_000n);
      expect(await harness.balanceOf(account.accountId)).toBe(1_000_000n);
      const { rows } = await app.query(
        `SELECT w.provider_reference, w.customer_fee_minor::text AS fee, w.total_debit_minor::text AS total, r.expiry_policy, r.status
           FROM paystack_withdrawals w JOIN reservations r ON r.id = w.reservation_id WHERE w.flow_id = $1`,
        [withdrawal.flowId],
      );
      expect(rows[0]).toEqual({
        provider_reference: providerReferenceOf(withdrawal.flowId),
        fee: '0',
        total: '300000',
        expiry_policy: 'FLOW_CONTROLLED',
        status: 'ACTIVE',
      });
      expect(providerReferenceOf(withdrawal.flowId)).toHaveLength(47);
      await harness.expectCleanBooks();
    });

    it('refuses another owner’s account, beneficiary or stash; a fee; a foreign reference; an unprovisioned bucket', async () => {
      const mine = await fundedAccount();
      const theirs = await fundedAccount();
      const myBeneficiary = await fixtures.readyBeneficiary(mine.userId);
      const theirBeneficiary = await fixtures.readyBeneficiary(theirs.userId);
      const myStash = await fixtures.stashOf(mine.userId);
      const theirStash = await fixtures.stashOf(theirs.userId);

      const attempt = async (overrides: Partial<Record<string, unknown>>) => {
        await app.query('BEGIN');
        try {
          const flow = (
            await app.query(
              `INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('PAYSTACK_WITHDRAWAL', 'RESERVED', $1) RETURNING id`,
              [mine.userId],
            )
          ).rows[0] as { id: string };
          const values = {
            account_id: mine.accountId,
            stash_id: myStash,
            beneficiary_id: myBeneficiary.beneficiaryId,
            customer_fee_minor: '0',
            total_debit_minor: '1000',
            provider_reference: providerReferenceOf(flow.id),
            internal_bucket: 0,
            ...overrides,
          };
          await app.query(
            `INSERT INTO paystack_withdrawals (flow_id, user_id, account_id, stash_id, beneficiary_id, currency_code, principal_minor,
               customer_fee_minor, total_debit_minor, provider_account_identity, provider_reference, internal_bucket)
             VALUES ($1, $2, $3, $4, $5, 'NGN', 1000, $6, $7, $8, $9, $10)`,
            [flow.id, mine.userId, values.account_id, values.stash_id, values.beneficiary_id, values.customer_fee_minor,
              values.total_debit_minor, PROVIDER_ACCOUNT_IDENTITY, values.provider_reference, values.internal_bucket],
          );
        } finally {
          await app.query('ROLLBACK');
        }
      };

      await expect(attempt({ account_id: theirs.accountId })).rejects.toThrow(/debit its owner's NGN wallet account/);
      await expect(attempt({ beneficiary_id: theirBeneficiary.beneficiaryId })).rejects.toThrow(/beneficiary_owner_foreign_key/);
      await expect(attempt({ stash_id: theirStash })).rejects.toThrow(/stash_owner_foreign_key/);
      await expect(attempt({ customer_fee_minor: '1', total_debit_minor: '1001' })).rejects.toThrow(/customer_fee_zero/);
      await expect(attempt({ total_debit_minor: '999' })).rejects.toThrow(/total_debit/);
      await expect(attempt({ provider_reference: 'withdrawal-00000000-0000-4000-8000-000000000000' })).rejects.toThrow(
        /reference_derived/,
      );
      await expect(attempt({ internal_bucket: 999 })).rejects.toThrow(/not provisioned/);
      await expect(attempt({})).resolves.toBeUndefined();
    });

    it('the frozen destination must be exactly the READY beneficiary of the withdrawal', async () => {
      const withdrawal = await admitted();
      await expect(
        app.query(`INSERT INTO withdrawal_destinations SELECT * FROM withdrawal_destinations WHERE withdrawal_id = $1`, [
          withdrawal.flowId,
        ]),
      ).rejects.toThrow(/withdrawal_destinations_pkey/);
      await expect(
        app.query(`UPDATE withdrawal_destinations SET bank_code = '011' WHERE withdrawal_id = $1`, [withdrawal.flowId]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        owner.query(`UPDATE withdrawal_destinations SET bank_code = '011' WHERE withdrawal_id = $1`, [withdrawal.flowId]),
      ).rejects.toThrow(/append-only/);
    });

    it('no other flow may claim the protection, and a payout hold cannot be AUTOMATIC', async () => {
      const account = await fundedAccount();
      const [fundingFlow] = await harness.newFlowIds(1);
      await expect(
        app.query(
          `INSERT INTO reservations (account_id, flow_id, amount_minor, expires_at, expiry_policy)
           VALUES ($1, $2, 100, now() + interval '1 hour', 'FLOW_CONTROLLED')`,
          [account.accountId, fundingFlow],
        ),
      ).rejects.toThrow(/FLOW_CONTROLLED reservation cannot belong to a FUNDING flow/);
      const withdrawal = await admitted();
      await expect(
        app.query(
          `INSERT INTO reservations (account_id, flow_id, amount_minor, expires_at) VALUES ($1, $2, 100, now() + interval '1 hour')`,
          [account.accountId, withdrawal.flowId],
        ),
      ).rejects.toThrow(/AUTOMATIC reservation cannot belong to a PAYSTACK_WITHDRAWAL flow/);
    });
  });

  describe('protected holds', () => {
    it('never expire, for any role', async () => {
      const withdrawal = await admitted();
      for (const client of [app, owner, superuser]) {
        await expect(
          client.query(`UPDATE reservations SET status = 'EXPIRED', resolved_at = now() WHERE id = $1`, [withdrawal.reservationId]),
        ).rejects.toThrow(/flow-controlled: it never expires/);
      }
    });

    it('a generic release or settle without the withdrawal’s facts fails at commit', async () => {
      const withdrawal = await admitted();
      await expect(harness.reservations.release(withdrawal.reservationId)).rejects.toThrow(
        /unresolved but its hold is RELEASED/,
      );
      expect(await harness.reservedOf(withdrawal.owner.accountId)).toBe(300_000n);
      const sent = await admitted();
      await expect(fixtures.fail(sent, { sent: true, certify: false })).rejects.toThrow(
        /failed after sending without a definitive-failure certificate/,
      );
      expect(await harness.reservedOf(sent.owner.accountId)).toBe(300_000n);
    });
  });

  describe('outcomes', () => {
    it('completion: one settlement by the principal posting, one confirmation, the stash derived from receipts', async () => {
      const account = await fundedAccount(1_000_000n);
      const withdrawal = await admitted(300_000n, account);
      const before = await harness.snapshot();
      const completion = await fixtures.complete(withdrawal);

      expect(await harness.balanceOf(account.accountId)).toBe(700_000n);
      expect(await harness.reservedOf(account.accountId)).toBe(0n);
      expect(await fixtures.stashBalance(account.userId)).toBe(300_000n);
      const after = await harness.snapshot();
      expect(after.transactionCount - before.transactionCount).toBe(2);
      const { rows } = await app.query(
        `SELECT t.reference, t.type, r.status, r.settlement_transaction_id = t.id AS linked
           FROM paystack_withdrawals w JOIN transactions t ON t.id = w.principal_transaction_id
           JOIN reservations r ON r.id = w.reservation_id WHERE w.flow_id = $1`,
        [withdrawal.flowId],
      );
      expect(rows[0]).toEqual({ reference: `withdrawal:${withdrawal.flowId}`, type: 'WITHDRAWAL', status: 'SETTLED', linked: true });

      // Accepted D3: the payout balance carries the unbacked debit; in-transit is discharged; nothing is clamped.
      const accounts = await resolvePayoutAccounts(harness.unitOfWork.manager, 'NGN', withdrawal.bucket);
      expect(await harness.balanceOf(accounts.payoutInTransitId)).toBe(0n);
      expect(await harness.balanceOf(accounts.payoutBalanceId)).toBeLessThanOrEqual(-300_000n);
      await harness.expectCleanBooks();

      // A replayed receipt call returns the same receipt and adds nothing.
      const replay = await app.query(`SELECT record_stash_receipt($1, $2) AS id`, [withdrawal.flowId, completion.verificationId]);
      expect((replay.rows[0] as { id: string }).id).toBe(completion.receiptId);
      expect(await fixtures.stashBalance(account.userId)).toBe(300_000n);
    });

    it('POSTED without its confirmation cannot commit', async () => {
      const withdrawal = await admitted();
      await expect(fixtures.complete(withdrawal, { skipReceipt: true })).rejects.toThrow(/posted without exactly one confirmation/);
      expect(await harness.reservedOf(withdrawal.owner.accountId)).toBe(300_000n);
      await harness.expectCleanBooks();
    });

    it('failure: unsent cancellation and verified failure release the hold once; no posting, no receipt', async () => {
      const unsent = await admitted();
      await fixtures.fail(unsent, { sent: false });
      const sent = await admitted();
      await fixtures.fail(sent, { sent: true });
      for (const withdrawal of [unsent, sent]) {
        expect(await harness.reservedOf(withdrawal.owner.accountId)).toBe(0n);
        expect(await harness.balanceOf(withdrawal.owner.accountId)).toBe(1_000_000n);
        expect(await fixtures.stashBalance(withdrawal.owner.userId)).toBe(0n);
      }
      await harness.expectCleanBooks();
    });

    it('full return after success: principal compensated, provider return booked, reversal receipt, stash back to zero', async () => {
      const account = await fundedAccount(1_000_000n);
      const withdrawal = await admitted(300_000n, account);
      const completion = await fixtures.complete(withdrawal);
      const reversal = await fixtures.reverse(withdrawal, completion);

      expect(await harness.balanceOf(account.accountId)).toBe(1_000_000n);
      expect(await fixtures.stashBalance(account.userId)).toBe(0n);
      const { rows } = await app.query(
        `SELECT event_kind, reverses_receipt_id FROM stash_receipts WHERE withdrawal_id = $1 ORDER BY event_kind`,
        [withdrawal.flowId],
      );
      expect(rows).toEqual([
        { event_kind: 'CONFIRMATION', reverses_receipt_id: null },
        { event_kind: 'REVERSAL', reverses_receipt_id: completion.receiptId },
      ]);
      const original = await app.query(`SELECT status FROM transactions WHERE id = $1`, [completion.principalTransactionId]);
      expect((original.rows[0] as { status: string }).status).toBe('REVERSED');
      expect(reversal.receiptId).toBeDefined();
      await harness.expectCleanBooks();
    });
  });

  describe('verifications', () => {
    let withdrawal: AdmittedWithdrawal;
    beforeAll(async () => {
      withdrawal = await admitted();
      await fixtures.markSubmitting(withdrawal.flowId);
      await fixtures.bindTransfer(withdrawal.flowId);
    });

    it.each([
      ['a different amount', { amountMinor: 299_999n }, /exact principal and currency/],
      ['a missing amount', { amountMinor: null }, /exact principal and currency/],
      ['another currency', { currency: 'USD' }, /exact principal and currency/],
      ['another recipient', { fingerprint: randomBytes(32) }, /frozen recipient identity/],
      ['the live domain', { domain: 'live' }, /test-domain observation/],
      ['another transfer', { transferId: '99999999', transferCode: 'TRF_other' }, /names a different transfer/],
      ['a pending status', { classification: 'PENDING' }, /cannot rest on a PENDING observation/],
      ['an initiate answer', { operation: 'transfer.initiate' }, /comes only from transfer.verify/],
    ])('a SUCCESS certificate cannot rest on %s', async (_label, input, pattern) => {
      const observation = await fixtures.observe(withdrawal, input);
      await expect(fixtures.verify(withdrawal, 'SUCCESS', observation)).rejects.toThrow(pattern);
    });

    it('a signed webhook is never a success certificate, and value times are never invented', async () => {
      const [webhook] = (await harness.dataSource.query(
        `INSERT INTO webhook_events (provider, raw_payload, headers, signature_valid) VALUES ('paystack', '\\x7b7d', '{}', TRUE) RETURNING id`,
      )) as { id: string }[];
      const fromWebhook = await harness.dataSource.query(
        `INSERT INTO paystack_transfer_observations (withdrawal_id, provider_account_identity, operation, observed_domain,
           provider_reference, status_classification, amount_minor, currency_code, evidence_id, response_sha256, source, webhook_event_id)
         VALUES ($1, $2, 'webhook.transfer', 'test', $3, 'SUCCESS', $4, 'NGN', $5, $6, 'WEBHOOK', $7) RETURNING id, observed_at`,
        [withdrawal.flowId, PROVIDER_ACCOUNT_IDENTITY, providerReferenceOf(withdrawal.flowId), withdrawal.principalMinor.toString(),
          await fixtures.evidence(), randomBytes(32), webhook.id],
      ) as { id: string; observed_at: Date }[];
      await expect(
        fixtures.verify(withdrawal, 'SUCCESS', { observationId: fromWebhook[0].id, observedAt: fromWebhook[0].observed_at }),
      ).rejects.toThrow(/frozen recipient identity|comes only from transfer.verify/);

      const observation = await fixtures.observe(withdrawal);
      await expect(
        fixtures.verify(withdrawal, 'SUCCESS', { ...observation, observedAt: new Date(observation.observedAt.getTime() - 1) }),
      ).rejects.toThrow(/observed test-state time is the matched observation's time/);
      await expect(
        harness.dataSource.query(
          `INSERT INTO withdrawal_verifications (withdrawal_id, user_id, currency_code, amount_minor, observation_id, outcome, value_time, value_time_basis)
           VALUES ($1, $2, 'NGN', $3, $4, 'SUCCESS', now(), 'PROVIDER_EVENT_TIME')`,
          [withdrawal.flowId, withdrawal.owner.userId, withdrawal.principalMinor.toString(), observation.observationId],
        ),
      ).rejects.toThrow(/provider event time is the success's transferred_at/);
      await expect(
        harness.dataSource.query(
          `INSERT INTO withdrawal_verifications (withdrawal_id, user_id, currency_code, amount_minor, observation_id, outcome, value_time, value_time_basis)
           VALUES ($1, $2, 'NGN', 1, $3, 'SUCCESS', $4, 'OBSERVED_TEST_STATE')`,
          [withdrawal.flowId, withdrawal.owner.userId, observation.observationId, observation.observedAt],
        ),
      ).rejects.toThrow(/withdrawal_verifications_principal_foreign_key/);
    });

    it('observation sources are shaped; a mismatched reference cannot bind to the intent', async () => {
      await expect(
        harness.dataSource.query(
          `INSERT INTO paystack_transfer_observations (withdrawal_id, provider_account_identity, operation, provider_reference,
             status_classification, evidence_id, response_sha256, source)
           VALUES ($1, $2, 'transfer.verify', 'withdrawal-someone-else', 'SUCCESS', $3, $4, 'RESUMER')`,
          [withdrawal.flowId, PROVIDER_ACCOUNT_IDENTITY, await fixtures.evidence(), randomBytes(32)],
        ),
      ).rejects.toThrow(/must carry its reference and namespace/);
      await expect(
        harness.dataSource.query(
          `INSERT INTO paystack_transfer_observations (provider_account_identity, operation, status_classification, evidence_id,
             response_sha256, source)
           VALUES ($1, 'transfer.verify', 'SUCCESS', $2, $3, 'RECONCILIATION')`,
          [PROVIDER_ACCOUNT_IDENTITY, await fixtures.evidence(), randomBytes(32)],
        ),
      ).rejects.toThrow(/source_shape/);
      // An unattributed transfer is still recorded — without an intent.
      await harness.dataSource.query(
        `INSERT INTO paystack_transfer_observations (provider_account_identity, operation, provider_reference, status_classification,
           evidence_id, response_sha256, source)
         VALUES ($1, 'transfer.list', 'unknown-reference', 'SUCCESS', $2, $3, 'RESUMER')`,
        [PROVIDER_ACCOUNT_IDENTITY, await fixtures.evidence(), randomBytes(32)],
      );
    });
  });

  describe('receipts and accounting events (application-role attacks)', () => {
    it('fx_app cannot write receipts directly, and the receipt function refuses anything but a matched success or return', async () => {
      const withdrawal = await admitted();
      const completion = await fixtures.complete(withdrawal);
      await expect(
        app.query(`INSERT INTO stash_receipts (stash_id) VALUES (gen_random_uuid())`),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query(`UPDATE stash_receipts SET amount_minor = 1`)).rejects.toThrow(/permission denied/);
      await expect(owner.query(`UPDATE stash_receipts SET amount_minor = 1 WHERE id = $1`, [completion.receiptId])).rejects.toThrow(
        /append-only/,
      );
      await expect(superuser.query(`DELETE FROM stash_receipts WHERE id = $1`, [completion.receiptId])).rejects.toThrow(/append-only/);

      const other = await admitted();
      await expect(app.query(`SELECT record_stash_receipt($1, $2)`, [other.flowId, completion.verificationId])).rejects.toThrow(
        /no verification/,
      );
      const failed = await admitted();
      await fixtures.markSubmitting(failed.flowId);
      const observation = await fixtures.observe(failed, { classification: 'FAILED' });
      const failure = await fixtures.verify(failed, 'DEFINITIVE_FAILURE', observation);
      await expect(app.query(`SELECT record_stash_receipt($1, $2)`, [failed.flowId, failure])).rejects.toThrow(/changes no stash/);
    });

    it('a receipt cannot cite an unposted withdrawal, even through the definer function', async () => {
      const withdrawal = await admitted();
      await fixtures.markSubmitting(withdrawal.flowId);
      await fixtures.bindTransfer(withdrawal.flowId);
      const verification = await fixtures.verify(withdrawal, 'SUCCESS', await fixtures.observe(withdrawal));
      await expect(app.query(`SELECT record_stash_receipt($1, $2)`, [withdrawal.flowId, verification])).rejects.toThrow(
        /null value in column "ledger_transaction_id"|needs its verified success and principal posting/,
      );
    });

    it('an accounting event must match the posting matrix in the withdrawal’s bucket; fee refunds never exceed the fee', async () => {
      const withdrawal = await admitted();
      const completion = await fixtures.complete(withdrawal);
      const accounts = await resolvePayoutAccounts(harness.unitOfWork.manager, 'NGN', withdrawal.bucket);
      const observationId = ((await app.query(
        `SELECT observation_id FROM withdrawal_verifications WHERE id = $1`,
        [completion.verificationId],
      )).rows[0] as { observation_id: string }).observation_id;
      const postFee = async (reference: string, debitId: string, creditId: string, amount: bigint) => {
        const { Money } = await import('../../src/common/money');
        const { EntryDirection, PostingAuthorization, TransactionType } = await import('../../src/modules/ledger/ledger.types');
        return harness.ledger.post({
          transaction: { type: TransactionType.SETTLEMENT, authorization: PostingAuthorization.SYSTEM_DRIVEN, valueTime: new Date(),
            initiatedBy: 'job:withdrawal', reference },
          entries: [
            { account: { accountId: debitId }, direction: EntryDirection.DEBIT, amount: Money.of(amount, 'NGN') },
            { account: { accountId: creditId }, direction: EntryDirection.CREDIT, amount: Money.of(amount, 'NGN') },
          ],
        });
      };
      const recordEvent = (kind: string, amount: bigint, transactionId: string, original: string | null) =>
        app.query(
          `INSERT INTO withdrawal_accounting_events (withdrawal_id, event_kind, currency_code, amount_minor, transaction_id, evidence_basis,
             observation_id, original_event_id, provider_event_identity, fee_component)
           VALUES ($1, $2, 'NGN', $3, $4, 'TRANSFER_STATE', $5, $6, 'fee-event-1', 'transfer_fee') RETURNING id`,
          [withdrawal.flowId, kind, amount.toString(), transactionId, observationId, original],
        );
      const prefix = `withdrawal-provider-fee:${withdrawal.flowId}:fee-event-1:transfer_fee`;

      const wrongSides = await postFee(`${prefix}-x`, accounts.payoutBalanceId, accounts.transferFeesId, 1_000n);
      await expect(recordEvent('PROVIDER_FEE', 1_000n, wrongSides.transactionId, null)).rejects.toThrow(/must be DR EXPENSE/);
      const fee = await postFee(prefix, accounts.transferFeesId, accounts.payoutBalanceId, 1_000n);
      const feeEvent = ((await recordEvent('PROVIDER_FEE', 1_000n, fee.transactionId, null)).rows[0] as { id: string }).id;

      const refundPrefix = `withdrawal-provider-fee-refund:${withdrawal.flowId}:fee-event-1:transfer_fee`;
      const firstRefund = await postFee(`${refundPrefix}:1`, accounts.payoutBalanceId, accounts.transferFeesId, 600n);
      await recordEvent('PROVIDER_FEE_REFUND', 600n, firstRefund.transactionId, feeEvent);
      const excessive = await postFee(`${refundPrefix}:2`, accounts.payoutBalanceId, accounts.transferFeesId, 401n);
      await expect(recordEvent('PROVIDER_FEE_REFUND', 401n, excessive.transactionId, feeEvent)).rejects.toThrow(
        /would exceed the fee charged/,
      );
      await expect(
        app.query(
          `INSERT INTO withdrawal_accounting_events (withdrawal_id, event_kind, currency_code, amount_minor, transaction_id, evidence_basis,
             observation_id, provider_event_identity)
           VALUES ($1, 'PRINCIPAL_DEBIT', 'NGN', $2, $3, 'TRANSFER_STATE', $4, 'again')`,
          [withdrawal.flowId, withdrawal.principalMinor.toString(), completion.principalTransactionId, observationId],
        ),
      ).rejects.toThrow(/exact principal under its own reference|principal_debit_unique/);
    });
  });

  describe('evidence and progression', () => {
    it('evidence is immutable and untruncatable for every role, superuser included', async () => {
      const evidence = await fixtures.evidence();
      for (const client of [app, owner, superuser]) {
        await expect(client.query(`UPDATE protected_provider_evidence SET key_id = 'k' WHERE id = $1`, [evidence])).rejects.toThrow(
          /permission denied|append-only/,
        );
        await expect(client.query(`DELETE FROM protected_provider_evidence WHERE id = $1`, [evidence])).rejects.toThrow(
          /permission denied|append-only/,
        );
      }
      for (const table of ['protected_provider_evidence', 'paystack_transfer_observations', 'stash_receipts', 'customer_stashes',
        'paystack_withdrawals', 'withdrawal_beneficiaries', 'paystack_balance_ledger_rows']) {
        await expect(superuser.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/append-only/);
      }
    });

    it('withdrawal progression is set once; identity is immutable; nothing is deleted', async () => {
      const withdrawal = await admitted();
      await fixtures.markSubmitting(withdrawal.flowId);
      await fixtures.bindTransfer(withdrawal.flowId);
      await expect(
        app.query(`UPDATE paystack_withdrawals SET provider_transfer_id = '1', provider_transfer_code = 'TRF_1' WHERE flow_id = $1`, [
          withdrawal.flowId,
        ]),
      ).rejects.toThrow(/set once/);
      await expect(
        app.query(`UPDATE paystack_withdrawals SET principal_minor = 1 WHERE flow_id = $1`, [withdrawal.flowId]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        owner.query(`UPDATE paystack_withdrawals SET principal_minor = 1, total_debit_minor = 1 WHERE flow_id = $1`, [withdrawal.flowId]),
      ).rejects.toThrow(/immutable apart from its progression/);
      await expect(owner.query(`DELETE FROM paystack_withdrawals WHERE flow_id = $1`, [withdrawal.flowId])).rejects.toThrow(
        /never deleted/,
      );
      // An unmarked flow cannot jump to SUBMITTING; RESERVED cannot jump to POSTED.
      const fresh = await admitted();
      await expect(transaction(app, [[`UPDATE flow_instances SET state = 'SUBMITTING' WHERE id = $1`, [fresh.flowId]]])).rejects.toThrow(
        /disagrees with its submission marker/,
      );
      await expect(transaction(app, [[`UPDATE flow_instances SET state = 'POSTED' WHERE id = $1`, [fresh.flowId]]])).rejects.toThrow(
        /cannot move from RESERVED to POSTED/,
      );
    });
  });
});
