import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { AppConfig } from '../../src/config/configuration';
import { APP_CONFIG } from '../../src/config/config.module';
import { AuditLogService } from '../../src/modules/audit/audit-log.service';
import { PaystackTransfersGateway, PaystackTransferCallFailedError, PaystackTransferRefusal, TransferCallFailureKind, TransferStatusClassification } from '../../src/modules/payments/paystack/transfers/paystack-transfers.port';
import { PaystackWebhookRouter } from '../../src/modules/payments/paystack/webhooks/paystack-webhook-router';
import { STORED_PAYLOAD_COLUMNS, StoredWebhookPayloadReader, StoredWebhookPayloadRow } from '../../src/modules/payments/webhooks/stored-webhook-payload';
import { DataKeyStore } from '../../src/modules/protection/data-key.store';
import { ProtectedEvidenceService } from '../../src/modules/protection/protected-evidence.service';
import { ProtectionService } from '../../src/modules/protection/protection.service';
import { UnitOfWork } from '../../src/database/transaction/unit-of-work';
import { LedgerHarness, PaymentsHarness, PaystackHarness, startLedgerHarness } from '../support/ledger-harness';
import { WithdrawalFixtures } from '../support/withdrawal-fixtures';

const ACCOUNT = '0123456789';
const NAME = 'ADA LOVELACE';

/**
 * W2 — the Paystack boundary (WITHDRAWAL_PLAN.md §H, §I.1): data keys and their audited rewrap, sealed evidence bound
 * to its row, the real transfers adapter over real HTTP against the simulated Paystack (exact integers, ids beyond
 * 2^53, refusals, one effective transfer after a lost answer, nothing sensitive in `provider_calls`), and the one
 * webhook ingress: family first, transfer payloads sealed, funding/transfer id collisions routed nowhere, conflicts
 * recorded. Real Postgres and Redis; no test reaches the real Paystack.
 */
describe('Paystack transfers boundary (W2, integration)', () => {
  let harness: LedgerHarness;
  let payments: PaymentsHarness;
  let paystack: PaystackHarness;
  let gateway: PaystackTransfersGateway;
  let fixtures: WithdrawalFixtures;
  let owner: Client;
  let superuser: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness({}, { paystack: { transfers: true } });
    payments = harness.payments!;
    paystack = payments.paystack!;
    gateway = harness.moduleRef.get(PaystackTransfersGateway);
    fixtures = new WithdrawalFixtures(harness);
    [owner, superuser] = await Promise.all([harness.db.ownerClient(), harness.db.superuserClient()]);
    paystack.mock.transfers.addAccount('058', ACCOUNT, NAME);
    paystack.mock.transfers.setBalance(10n ** 18n);
  });
  afterAll(async () => {
    await Promise.all([owner?.end(), superuser?.end()]);
    await harness?.close();
  });
  beforeEach(() => {
    paystack.mock.clearFaults();
    paystack.mock.dropWebhooks();
  });

  const sensitiveRecorded = async (...values: string[]) => {
    const [row] = (await harness.dataSource.query(
      `SELECT count(*)::int AS count FROM provider_calls
        WHERE ${values.map((_, index) => `(coalesce(request_path, '') || coalesce(request_body::text, '') || coalesce(response_body::text, '') || coalesce(error, '')) LIKE $${index + 1}`).join(' OR ')}`,
      values.map((value) => `%${value}%`),
    )) as { count: number }[];
    return row.count;
  };

  describe('data keys and sealed evidence', () => {
    it('one wrapped key per user; the database never holds a key in the clear', async () => {
      const store = harness.moduleRef.get(DataKeyStore);
      const { userId } = await harness.createWallet();
      const first = await harness.unitOfWork.run(() => store.forUser(userId));
      const again = await harness.unitOfWork.run(() => store.forUser(userId));
      expect(again.id).toBe(first.id);
      const [row] = (await harness.dataSource.query(`SELECT wrapped_key, key_encryption_key_id FROM data_encryption_keys WHERE id = $1`, [first.id])) as {
        wrapped_key: Buffer;
        key_encryption_key_id: string;
      }[];
      expect(row.key_encryption_key_id).toBe('test-kek-1');
      expect(row.wrapped_key).toHaveLength(61);
      expect(row.wrapped_key.includes(first.key)).toBe(false);
    });

    it('rewrap moves only the wrapping (audited); old wrapping keys must stay configured until then', async () => {
      const config = harness.moduleRef.get<AppConfig>(APP_CONFIG);
      const unitOfWork = harness.moduleRef.get(UnitOfWork);
      const audit = harness.moduleRef.get(AuditLogService);
      const oldRing = config.protection.keyEncryption!;
      const rotated = {
        ...config,
        protection: { ...config.protection, keyEncryption: { activeKeyId: 'test-kek-2', keys: new Map([...oldRing.keys, ['test-kek-2', randomBytes(32)]]) } },
      } as AppConfig;
      const before = new DataKeyStore(unitOfWork, audit, config);
      const { userId } = await harness.createWallet();
      const key = await unitOfWork.run(() => before.forUser(userId));

      const after = new DataKeyStore(unitOfWork, audit, rotated);
      expect(await after.rewrap(key.id, { type: 'SYSTEM' }, 'test rotation')).toBe(true);
      expect(await after.rewrap(key.id, { type: 'SYSTEM' }, 'test rotation')).toBe(false);
      const fresh = new DataKeyStore(unitOfWork, audit, rotated);
      expect((await fresh.byId(key.id)).key.equals(key.key)).toBe(true);
      const onlyNew = new DataKeyStore(unitOfWork, audit, {
        ...rotated,
        protection: { ...rotated.protection, keyEncryption: { activeKeyId: 'test-kek-1', keys: new Map([['test-kek-1', oldRing.keys.get('test-kek-1')!]]) } },
      } as AppConfig);
      await expect(onlyNew.byId(key.id)).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      const [trail] = (await harness.dataSource.query(
        `SELECT action, before, after FROM audit_logs WHERE subject_type = 'DATA_ENCRYPTION_KEY' AND subject_id = $1`,
        [key.id],
      )) as { action: string; before: unknown; after: unknown }[];
      expect(trail).toEqual({ action: 'DATA_KEY_REWRAPPED', before: { keyEncryptionKeyId: 'test-kek-1' }, after: { keyEncryptionKeyId: 'test-kek-2' } });
    });

    it('data key identity is immutable and keys are never deleted, for any role', async () => {
      const { userId } = await harness.createWallet();
      const key = await harness.unitOfWork.run(() => harness.moduleRef.get(DataKeyStore).forUser(userId));
      const app = await harness.db.appClient();
      try {
        await expect(app.query(`DELETE FROM data_encryption_keys WHERE id = $1`, [key.id])).rejects.toThrow(/permission denied/);
        await expect(owner.query(`UPDATE data_encryption_keys SET user_id = NULL, purpose = 'PROVIDER_EVIDENCE' WHERE id = $1`, [key.id])).rejects.toThrow(/identity is immutable/);
        await expect(owner.query(`UPDATE data_encryption_keys SET wrapped_key = wrapped_key WHERE id = $1`, [key.id])).resolves.toBeDefined();
        await expect(owner.query(`UPDATE data_encryption_keys SET wrapped_key = $2 WHERE id = $1`, [key.id, randomBytes(61)])).rejects.toThrow(/without recording when/);
        await expect(superuser.query(`DELETE FROM data_encryption_keys WHERE id = $1`, [key.id])).rejects.toThrow(/never deleted/);
      } finally {
        await app.end();
      }
    });

    it('evidence stores the exact bytes sealed; a sealed value copied to another row does not open', async () => {
      const evidence = harness.moduleRef.get(ProtectedEvidenceService);
      const content = Buffer.from(`{"status":true,"data":{"account_number":"${ACCOUNT}","amount":9007199254740993}}`, 'utf8');
      const stored = await harness.unitOfWork.run(() => evidence.store({ provider: 'paystack', operation: 'bank.resolve', content }));
      expect((await evidence.read(stored.evidenceId)).equals(content)).toBe(true);
      const [row] = (await harness.dataSource.query(`SELECT sealed_content, key_id, content_sha256 FROM protected_provider_evidence WHERE id = $1`, [stored.evidenceId])) as {
        sealed_content: Buffer;
        key_id: string;
        content_sha256: Buffer;
      }[];
      expect(row.sealed_content.includes(Buffer.from(ACCOUNT))).toBe(false);
      expect(row.content_sha256.equals(createHash('sha256').update(content).digest())).toBe(true);

      const [copy] = (await harness.dataSource.query(
        `INSERT INTO protected_provider_evidence (provider, environment, operation, codec_version, key_id, sealed_content, content_sha256, content_length)
         VALUES ('paystack', 'test', 'bank.resolve', 1, $1, $2, $3, $4) RETURNING id`,
        [row.key_id, row.sealed_content, row.content_sha256, content.length],
      )) as { id: string }[];
      await expect(evidence.read(copy.id)).rejects.toThrow(/failed authentication/);
    });

    it('destination fingerprints are keyed, owner-bound and stable', () => {
      const protection = harness.moduleRef.get(ProtectionService);
      const identity = { userId: '3f2c4c3e-8d2b-4a51-9b6f-0e1d2c3b4a59', bankCode: '058', accountNumber: ACCOUNT, recipientType: 'nuban', currency: 'NGN' };
      const one = protection.destinationFingerprint(identity);
      expect(one.keyId).toBe('test-fingerprint-1');
      expect(protection.destinationFingerprint(identity).digest.equals(one.digest)).toBe(true);
      expect(protection.destinationFingerprint({ ...identity, userId: '00000000-0000-4000-8000-000000000000' }).digest.equals(one.digest)).toBe(false);
      expect(one.digest.equals(createHash('sha256').update(ACCOUNT).digest())).toBe(false);
    });
  });

  describe('the transfers adapter over real HTTP', () => {
    it('resolves an account (leading zeroes kept) and records neither the number nor the name', async () => {
      paystack.mock.transfers.addAccount('044', '0001234567', null);
      const resolved = await gateway.resolveAccount(ACCOUNT, '058', {});
      expect(resolved.value).toEqual({ accountNumber: ACCOUNT, accountName: NAME, bankId: '2' });
      expect(resolved.exchange.rawResponse?.toString('utf8')).toContain(ACCOUNT);
      expect((await gateway.resolveAccount('0001234567', '044', {})).value.accountName).toBeNull();
      await expect(gateway.resolveAccount('9999999999', '058', {})).rejects.toMatchObject({ refusal: PaystackTransferRefusal.ACCOUNT_NOT_RESOLVED });
      expect(await sensitiveRecorded(ACCOUNT, NAME, 'LOVELACE')).toBe(0);
    });

    it('a duplicate account number returns the existing recipient; banks page by cursor', async () => {
      const first = await gateway.createRecipient({ name: 'Ada Lovelace', accountNumber: ACCOUNT, bankCode: '058', currency: 'NGN' }, {});
      const second = await gateway.createRecipient({ name: 'Ada Lovelace', accountNumber: ACCOUNT, bankCode: '058', currency: 'NGN' }, {});
      expect(second.value.recipientCode).toBe(first.value.recipientCode);
      expect((await gateway.fetchRecipient(first.value.recipientCode, {})).value?.details.accountNumber).toBe(ACCOUNT);
      expect((await gateway.fetchRecipient('RCP_missing', {})).value).toBeNull();
      paystack.mock.transfers.setBankPageSize(2);
      const codes: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await gateway.listBanks({ currency: 'NGN', cursor });
        codes.push(...result.value.items.map((bank) => bank.code));
        if (!result.value.nextCursor) break;
        cursor = result.value.nextCursor;
      }
      expect(codes).toEqual(['044', '058', '011', '033', '057']);
      expect(await sensitiveRecorded(ACCOUNT, 'Lovelace')).toBe(0);
    });

    it('initiates with an exact integer beyond 2^53; verify reads it back; transferred_at null is missing evidence', async () => {
      const recipient = (await gateway.createRecipient({ name: 'Ada Lovelace', accountNumber: ACCOUNT, bankCode: '058', currency: 'NGN' }, {})).value;
      const reference = `withdrawal-${'3f2c4c3e-8d2b-4a51-9b6f-'}${randomBytes(6).toString('hex')}`;
      const amount = 9_007_199_254_740_993n;
      const initiated = await gateway.initiateTransfer({ amountMinor: amount, currency: 'NGN', recipientCode: recipient.recipientCode, reference, reason: 'KoboFX withdrawal' }, {});
      expect(initiated.value).toMatchObject({ classification: TransferStatusClassification.SUCCESS, amountMinor: amount, reference });
      expect(paystack.mock.transfers.find(reference)?.amount).toBe(amount);
      const verified = await gateway.verifyTransfer(reference, {});
      expect(verified.found).toBe(true);
      if (!verified.found) return;
      expect(verified.observation).toMatchObject({ amountMinor: amount, transferredAt: null, feeChargedMinor: 1_000n, domain: 'test' });
      expect(BigInt(verified.observation.transferId!) > 2n ** 53n).toBe(true);
      expect(verified.observation.recipient?.details?.accountNumber).toBe(ACCOUNT);
    });

    it('a lost initiate answer: TRANSIENT, no retry, and verify by the same reference finds exactly one transfer', async () => {
      const recipient = (await gateway.createRecipient({ name: 'Ada Lovelace', accountNumber: ACCOUNT, bankCode: '058', currency: 'NGN' }, {})).value;
      const reference = `withdrawal-lost-${randomBytes(8).toString('hex')}`;
      const before = paystack.mock.statistics().requests.transfer_initiate;
      paystack.mock.failNext('transfer_initiate', 'timeout_after_effect');
      const failure = (await gateway
        .initiateTransfer({ amountMinor: 300_000n, currency: 'NGN', recipientCode: recipient.recipientCode, reference, reason: 'x' }, {})
        .catch((error: unknown) => error)) as PaystackTransferCallFailedError;
      expect(failure.kind).toBe(TransferCallFailureKind.TRANSIENT);
      expect(paystack.mock.statistics().requests.transfer_initiate - before).toBe(1);
      expect(paystack.mock.transfers.transfersFor(reference)).toBe(1);
      const verified = await gateway.verifyTransfer(reference, {});
      expect(verified.found && verified.observation.amountMinor).toBe(300_000n);

      // Re-sending the SAME reference cannot create a second transfer.
      await expect(
        gateway.initiateTransfer({ amountMinor: 300_000n, currency: 'NGN', recipientCode: recipient.recipientCode, reference, reason: 'x' }, {}),
      ).rejects.toMatchObject({ refusal: PaystackTransferRefusal.DUPLICATE_REFERENCE });
      expect(paystack.mock.transfers.transfersFor(reference)).toBe(1);
    });

    it('delayed visibility, insufficient balance and an invalid key are distinct outcomes', async () => {
      const recipient = (await gateway.createRecipient({ name: 'Ada Lovelace', accountNumber: ACCOUNT, bankCode: '058', currency: 'NGN' }, {})).value;
      const reference = `withdrawal-late-${randomBytes(8).toString('hex')}`;
      await gateway.initiateTransfer({ amountMinor: 1_000n, currency: 'NGN', recipientCode: recipient.recipientCode, reference, reason: 'x' }, {});
      paystack.mock.transfers.hideTransferFromVerify(reference, 1);
      expect((await gateway.verifyTransfer(reference, {})).found).toBe(false);
      expect((await gateway.verifyTransfer(reference, {})).found).toBe(true);

      const balance = paystack.mock.transfers.currentBalance();
      paystack.mock.transfers.setBalance(10n);
      await expect(
        gateway.initiateTransfer({ amountMinor: 1_000n, currency: 'NGN', recipientCode: recipient.recipientCode, reference: `withdrawal-poor-${randomBytes(8).toString('hex')}`, reason: 'x' }, {}),
      ).rejects.toMatchObject({ refusal: PaystackTransferRefusal.INSUFFICIENT_BALANCE, kind: TransferCallFailureKind.REFUSED });
      paystack.mock.transfers.setBalance(balance);

      const balances = await gateway.balances();
      expect(balances.value).toEqual([{ currency: 'NGN', balanceMinor: balance }]);
      const ledger = await gateway.balanceLedger({ from: new Date(0), to: new Date('9999-12-31T00:00:00.000Z') });
      expect(ledger.value.items.length).toBeGreaterThan(0);
      expect(ledger.value.items.every((row) => typeof row.differenceMinor === 'bigint')).toBe(true);
    });
  });

  describe('the webhook ingress', () => {
    const latestEvent = async () =>
      ((await harness.dataSource.query(
        `SELECT webhook_events.id, ${STORED_PAYLOAD_COLUMNS}, webhook_events.outcome, webhook_events.last_error, webhook_events.signature_valid
           FROM webhook_events ORDER BY received_at DESC, id DESC LIMIT 1`,
      )) as (StoredWebhookPayloadRow & { outcome: string | null; last_error: string | null; signature_valid: boolean })[])[0];
    const transferEvent = (fields: { event?: string; id?: string; code?: string; reference?: string; status?: string }) =>
      Buffer.from(
        `{"event":"${fields.event ?? 'transfer.success'}","data":{"id":${fields.id ?? '9007199254799999'},"transfer_code":"${fields.code ?? 'TRF_none'}",` +
          `"reference":"${fields.reference ?? 'withdrawal-unknown-reference'}","status":"${fields.status ?? 'success'}","amount":300000,"currency":"NGN",` +
          `"recipient":{"recipient_code":"RCP_x","details":{"account_number":"${ACCOUNT}","account_name":"${NAME}","bank_code":"058"}}}}`,
        'utf8',
      );

    it('a transfer event is stored SEALED (exact bytes recoverable, no account number at rest) and unmatched when unknown', async () => {
      const body = transferEvent({});
      expect(await paystack.mock.send(body)).toBe(200);
      const stored = await latestEvent();
      expect(stored.payload_encoding).toBe('SEALED_V1');
      expect(stored.raw_payload.includes(Buffer.from(ACCOUNT))).toBe(false);
      expect((await harness.moduleRef.get(StoredWebhookPayloadReader).read(stored)).equals(body)).toBe(true);
      await payments.processor.processDue(100);
      expect((await latestEvent()).outcome).toBe('UNMATCHED');
      expect(await sensitiveRecorded(ACCOUNT, 'LOVELACE')).toBe(0);
    });

    it('a forged delivery is stored sealed and refused; a valid charge event stays plaintext (funding unchanged)', async () => {
      expect(await paystack.mock.send(transferEvent({ id: '1' }), 'bad-signature')).toBe(401);
      const forged = await latestEvent();
      expect(forged).toMatchObject({ signature_valid: false, payload_encoding: 'SEALED_V1' });

      const user = await payments.signUp();
      const fundingId = ((await paystack.fund(user, { amount: '150000', currency: 'NGN' })).body as { fundingId: string }).fundingId;
      await payments.resumer.resumeDue(100);
      paystack.mock.pay(fundingId);
      expect(await paystack.mock.deliverAll()).toEqual([200]);
      expect((await latestEvent()).payload_encoding).toBe('PLAINTEXT_V1');
      await payments.processor.processDue(100);
      expect(((await paystack.status(user, fundingId)).body as { status: string }).status).toBe('COMPLETED');
    });

    it('a transfer event carrying a FUNDING transaction id is never routed to that funding', async () => {
      const user = await payments.signUp();
      const fundingId = ((await paystack.fund(user, { amount: '150000', currency: 'NGN' })).body as { fundingId: string }).fundingId;
      await payments.resumer.resumeDue(100);
      paystack.mock.pay(fundingId);
      await paystack.mock.deliverAll();
      await payments.processor.processDue(100);
      const [{ provider_payment_id: transactionId }] = (await harness.dataSource.query(
        `SELECT provider_payment_id FROM funding_payments WHERE flow_id = $1`,
        [fundingId],
      )) as { provider_payment_id: string }[];
      const before = (await harness.dataSource.query(`SELECT state, updated_at FROM flow_instances WHERE id = $1`, [fundingId])) as unknown[];

      const router = harness.moduleRef.get(PaystackWebhookRouter);
      expect(await router.resolve(transferEvent({ id: transactionId, reference: fundingId }))).toEqual({ eventType: 'transfer.success', flowId: null });
      expect(await paystack.mock.send(transferEvent({ id: transactionId, reference: fundingId, event: 'transfer.reversed', status: 'reversed' }))).toBe(200);
      await payments.processor.processDue(100);
      expect((await latestEvent()).outcome).toBe('UNMATCHED');
      expect(await harness.dataSource.query(`SELECT state, updated_at FROM flow_instances WHERE id = $1`, [fundingId])).toEqual(before);
    });

    it('a transfer event matches its withdrawal by reference or bound ids; disagreeing identifiers are a recorded conflict', async () => {
      const funded = async () => {
        const account = await harness.openUserAccount('NGN');
        await harness.fund(account, 1_000_000n);
        return fixtures.admit(account, await fixtures.readyBeneficiary(account.userId), 300_000n);
      };
      const [a, b] = [await funded(), await funded()];
      await fixtures.markSubmitting(a.flowId);
      await fixtures.markSubmitting(b.flowId);
      const boundA = await fixtures.bindTransfer(a.flowId);
      const boundB = await fixtures.bindTransfer(b.flowId);
      const router = harness.moduleRef.get(PaystackWebhookRouter);
      const referenceA = `withdrawal-${a.flowId}`;

      expect(await router.resolve(transferEvent({ reference: referenceA, id: boundA.transferId, code: boundA.transferCode }))).toEqual({ eventType: 'transfer.success', flowId: a.flowId });
      expect((await router.resolve(transferEvent({ reference: 'withdrawal-unknown-reference', id: boundB.transferId, code: boundB.transferCode })))?.flowId).toBeNull();
      expect(await router.resolve(transferEvent({ reference: referenceA, id: boundB.transferId, code: boundB.transferCode }))).toMatchObject({
        flowId: null,
        conflict: expect.stringContaining('2 withdrawals'),
      });
      expect(await router.resolve(transferEvent({ reference: referenceA, id: '123', code: boundA.transferCode }))).toMatchObject({ flowId: null, conflict: expect.stringContaining('disagree') });

      expect(await paystack.mock.send(transferEvent({ reference: referenceA, id: boundB.transferId, code: boundB.transferCode, status: 'failed', event: 'transfer.failed' }))).toBe(200);
      await payments.processor.processDue(100);
      const conflicted = await latestEvent();
      expect(conflicted.outcome).toBe('UNMATCHED');
      expect(conflicted.last_error).toMatch(/^conflict: /);
      expect(await harness.reservedOf(a.owner.accountId)).toBe(300_000n);
      expect(await harness.reservedOf(b.owner.accountId)).toBe(300_000n);
    });

    it('an unknown event family is preserved and unmatched, never guessed', async () => {
      expect(await paystack.mock.send(Buffer.from('{"event":"subscription.create","data":{"id":5,"reference":"x"}}'))).toBe(200);
      const stored = await latestEvent();
      expect(stored.payload_encoding).toBe('SEALED_V1');
      await payments.processor.processDue(100);
      expect((await latestEvent()).outcome).toBe('UNMATCHED');
    });
  });

  describe('schema', () => {
    it('the TS transfer classification equals the database enum', async () => {
      const rows = (await harness.dataSource.query(`SELECT unnest(enum_range(NULL::transfer_status_classification))::text AS value`)) as { value: string }[];
      expect(rows.map((row) => row.value)).toEqual(Object.values(TransferStatusClassification));
    });

    it('webhook envelopes are shaped and immutable; idempotency hash metadata is shaped', async () => {
      const [{ id }] = (await harness.dataSource.query(`SELECT id FROM webhook_events ORDER BY received_at DESC LIMIT 1`)) as { id: string }[];
      await expect(owner.query(`UPDATE webhook_events SET payload_encoding = 'PLAINTEXT_V1', payload_key_id = NULL, payload_sha256 = NULL WHERE id = $1`, [id])).rejects.toThrow(
        /immutable/,
      );
      await expect(
        owner.query(`INSERT INTO webhook_events (provider, raw_payload, headers, signature_valid, payload_encoding) VALUES ('paystack', '\\x00', '{}', TRUE, 'SEALED_V1')`),
      ).rejects.toThrow(/webhook_events_payload_envelope_shape/);
      const { userId } = await harness.createWallet();
      await expect(
        owner.query(
          `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash, request_hash_algorithm) VALUES ($1, 'POST /x', 'k-0123456789abcdef', $2, 'HMAC_SHA256_V1')`,
          [userId, 'a'.repeat(64)],
        ),
      ).rejects.toThrow(/idempotency_keys_request_hash_key_shape/);
    });
  });
});
