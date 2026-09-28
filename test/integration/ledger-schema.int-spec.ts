import { Client } from 'pg';
import { HashChainFault } from '../../src/modules/ledger/ledger-checks.service';
import { LedgerHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

/**
 * Immutability three ways (design §5.5): by construction (triggers that RAISE), by
 * permission (revoked grants), post-factum (the hash chain verifier). Plus the other
 * schema-level guards on transactions, accounts and period locks.
 */
describe('Ledger schema: immutability and guards (real Postgres 16)', () => {
  let harness: LedgerHarness;
  let app: Client;
  let owner: Client;
  let account: UserAccount;
  let entryIds: string[];

  beforeAll(async () => {
    harness = await startLedgerHarness({ LEDGER_INTERNAL_BUCKETS: '4' });
    app = await harness.db.appClient();
    owner = await harness.db.ownerClient();
    account = await harness.openUserAccount('NGN');
    for (const amount of [1_000n, 2_000n, 3_000n]) await harness.fund(account, amount);
    const rows = (await app.query(`SELECT id::text FROM ledger_entries WHERE account_id = $1 ORDER BY ledger_entries.id`, [account.accountId])).rows;
    entryIds = rows.map((row: { id: string }) => row.id);
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    await harness?.close();
  });

  describe('ledger_entries, by permission: fx_app cannot change history', () => {
    it.each([
      ['UPDATE', `UPDATE ledger_entries SET amount_minor = 1`],
      ['DELETE', `DELETE FROM ledger_entries`],
      ['TRUNCATE', `TRUNCATE ledger_entries`],
    ])('%s is permission denied', async (_operation, sql) => {
      await expect(app.query(sql)).rejects.toThrow(/permission denied for table ledger_entries/);
    });
  });

  describe('ledger_entries, by construction: even the owner is refused, loudly', () => {
    it('UPDATE raises the trigger exception naming the operation and row', async () => {
      await expect(owner.query(`UPDATE ledger_entries SET amount_minor = 1 WHERE id = $1`, [entryIds[0]])).rejects.toThrow(
        `ledger_entries is append-only (attempted UPDATE on id ${entryIds[0]})`,
      );
    });

    it('DELETE raises the trigger exception', async () => {
      await expect(owner.query(`DELETE FROM ledger_entries WHERE id = $1`, [entryIds[0]])).rejects.toThrow(
        `ledger_entries is append-only (attempted DELETE on id ${entryIds[0]})`,
      );
    });

    it('TRUNCATE raises the statement trigger exception', async () => {
      await expect(owner.query(`TRUNCATE ledger_entries CASCADE`)).rejects.toThrow(
        'ledger_entries is append-only (attempted TRUNCATE)',
      );
    });

    it('nothing changed: the rows are all still there and the chain verifies', async () => {
      const { rows } = await app.query(`SELECT count(*)::int AS count FROM ledger_entries WHERE account_id = $1`, [account.accountId]);
      expect(rows[0].count).toBe(3);
      expect(await harness.checks.verifyHashChains(account.accountId)).toEqual([]);
    });

    it('an entry in a currency other than its account’s is refused by the insert trigger', async () => {
      const [{ id: transactionId }] = (await app.query(`SELECT transaction_id AS id FROM ledger_entries WHERE id = $1`, [entryIds[0]])).rows;
      await expect(
        app.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, currency_code, direction, amount_minor, balance_after_minor, value_time)
           VALUES ($1, $2, 'USD', 'CREDIT', 1, 1, now())`,
          [transactionId, account.accountId],
        ),
      ).rejects.toThrow(/differs from account/);
    });

    it('the hash columns are computed by the database, whatever the caller sends', async () => {
      const { rows } = await app.query(
        `SELECT previous_hash, entry_hash,
                ledger_entry_hash(previous_hash, ledger_entry_canonical_text(
                  id, account_id, transaction_id, currency_code, direction, amount_minor,
                  balance_after_minor, value_time, booking_time)) AS recomputed
           FROM ledger_entries WHERE account_id = $1 ORDER BY id`,
        [account.accountId],
      );
      expect(rows[0].previous_hash).toBeNull();
      expect(rows[1].previous_hash).toEqual(rows[0].entry_hash);
      expect(rows[2].previous_hash).toEqual(rows[1].entry_hash);
      for (const row of rows) {
        expect(row.entry_hash).toHaveLength(32);
        expect(row.entry_hash).toEqual(row.recomputed);
      }
    });
  });

  describe('transactions: append-only except the correction link and POSTED → REVERSED', () => {
    let transactionId: string;

    beforeAll(async () => {
      transactionId = (await app.query(`SELECT transaction_id AS id FROM ledger_entries WHERE id = $1`, [entryIds[0]])).rows[0].id;
    });

    it('fx_app cannot DELETE or TRUNCATE transactions', async () => {
      await expect(app.query(`DELETE FROM transactions WHERE id = $1`, [transactionId])).rejects.toThrow(/permission denied/);
      await expect(app.query(`TRUNCATE transactions CASCADE`)).rejects.toThrow(/permission denied/);
    });

    it('the owner deleting a transaction hits the trigger', async () => {
      await expect(owner.query(`DELETE FROM transactions WHERE id = $1`, [transactionId])).rejects.toThrow(/never deleted/);
    });

    it.each([
      ['reason_code', `UPDATE transactions SET reason_code = 'edited' WHERE id = $1`],
      ['value_time', `UPDATE transactions SET value_time = now() - interval '1 day' WHERE id = $1`],
      ['metadata', `UPDATE transactions SET metadata = '{"x":1}' WHERE id = $1`],
    ])('editing %s raises', async (_column, sql) => {
      await expect(app.query(sql, [transactionId])).rejects.toThrow(/is immutable apart from/);
    });

    it('any status move other than POSTED → REVERSED raises', async () => {
      await expect(app.query(`UPDATE transactions SET status = 'PENDING' WHERE id = $1`, [transactionId])).rejects.toThrow(
        /cannot move from POSTED to PENDING/,
      );
    });

    it('the correction link can be set once, never changed', async () => {
      const other = (await app.query(`SELECT transaction_id AS id FROM ledger_entries WHERE id = $1`, [entryIds[1]])).rows[0].id;
      const third = (await app.query(`SELECT transaction_id AS id FROM ledger_entries WHERE id = $1`, [entryIds[2]])).rows[0].id;
      await app.query('BEGIN');
      try {
        await app.query(`UPDATE transactions SET corrected_by_transaction_id = $2 WHERE id = $1`, [transactionId, other]);
        await expect(
          app.query(`UPDATE transactions SET corrected_by_transaction_id = $2 WHERE id = $1`, [transactionId, third]),
        ).rejects.toThrow(/already corrected/);
      } finally {
        await app.query('ROLLBACK');
      }
    });

    it('a REVERSAL or CORRECTION row must link an original, and nothing may correct itself', async () => {
      await expect(
        app.query(
          `INSERT INTO transactions (reference, type, status, value_time, initiated_by) VALUES ('r-1', 'REVERSAL', 'POSTED', now(), 'job:x')`,
        ),
      ).rejects.toThrow(/transactions_correction_types_link_an_original/);
      await expect(
        app.query(
          `INSERT INTO transactions (id, reference, type, status, value_time, initiated_by, corrects_transaction_id)
           VALUES ('44444444-4444-4444-8444-444444444444', 'r-2', 'CORRECTION', 'POSTED', now(), 'job:x', '44444444-4444-4444-8444-444444444444')`,
        ),
      ).rejects.toThrow(/transactions_does_not_correct_itself|foreign key/);
    });
  });

  describe('accounts', () => {
    it('has no CHECK on balance_minor: a negative balance is representable (design §6.2)', async () => {
      const { rows } = await owner.query(
        `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'accounts'::regclass AND contype = 'c'`,
      );
      const definitions = rows.map((row: { definition: string }) => row.definition).join(' | ');
      expect(definitions).not.toMatch(/balance_minor/);
      expect(rows.map((row: { conname: string }) => row.conname)).toContain('accounts_reserved_sane');
    });

    it('keeps accounts_reserved_sane: reserved can never be negative', async () => {
      await expect(app.query(`UPDATE accounts SET reserved_minor = -1 WHERE id = $1`, [account.accountId])).rejects.toThrow(
        /accounts_reserved_sane/,
      );
    });

    it.each([
      ['currency_code', `UPDATE accounts SET currency_code = 'USD' WHERE id = $1`],
      ['normal_side', `UPDATE accounts SET normal_side = 'DEBIT' WHERE id = $1`],
      ['code', `UPDATE accounts SET code = 'USER:someone-else:NGN' WHERE id = $1`],
      ['authorizes_balance', `UPDATE accounts SET authorizes_balance = FALSE WHERE id = $1`],
    ])('an account’s identity (%s) cannot change', async (_column, sql) => {
      await expect(app.query(sql, [account.accountId])).rejects.toThrow(/account identity is immutable/);
    });

    it('fx_app cannot delete accounts', async () => {
      await expect(app.query(`DELETE FROM accounts WHERE id = $1`, [account.accountId])).rejects.toThrow(/permission denied/);
    });
  });

  describe('period_locks and templates', () => {
    it('fx_app can add a period lock but never edit or remove one', async () => {
      await app.query(
        `INSERT INTO period_locks (period_start, period_end, locked_by, reason)
         VALUES ('2020-01-01', '2020-02-01', 'operator:auditor', 'January 2020 reported')`,
      );
      await expect(app.query(`UPDATE period_locks SET reason = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM period_locks`)).rejects.toThrow(/permission denied/);
    });

    it('a period lock must be a non-empty interval', async () => {
      await expect(
        app.query(
          `INSERT INTO period_locks (period_start, period_end, locked_by, reason) VALUES ('2020-02-01', '2020-02-01', 'operator:a', 'x')`,
        ),
      ).rejects.toThrow(/period_locks_period_ordered/);
    });

    it('fx_app cannot change the system account templates', async () => {
      await expect(
        app.query(`INSERT INTO system_account_templates VALUES ('SNEAKY', 'ASSET', 'DEBIT', 'x')`),
      ).rejects.toThrow(/permission denied/);
    });
  });

  // These tamper with the database directly and so run last.
  describe('post-factum: the hash chain catches what the triggers and grants could not', () => {
    let superuser: Client;

    beforeAll(async () => {
      superuser = await harness.db.superuserClient();
    });

    afterAll(async () => {
      await superuser?.end();
    });

    it('a superuser who disables the trigger and edits one amount is caught at exactly that entry', async () => {
      const tampered = entryIds[1];
      await superuser.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_mutation`);
      await superuser.query(`UPDATE ledger_entries SET amount_minor = amount_minor + 1 WHERE id = $1`, [tampered]);
      await superuser.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_mutation`);

      expect(await harness.checks.verifyHashChains(account.accountId)).toEqual([
        { entryId: BigInt(tampered), accountId: account.accountId, faults: [HashChainFault.ENTRY_HASH_MISMATCH] },
      ]);
      // The other oracles see it too, and localise it the same way.
      const continuity = await harness.checks.findBalanceContinuityBreaks();
      expect(continuity.map((breakage) => breakage.entryId)).toEqual([BigInt(tampered)]);
      const mismatches = await harness.checks.findCachedBalanceMismatches();
      expect(mismatches.map((mismatch) => mismatch.accountId)).toEqual([account.accountId]);
      expect((await harness.checks.runAllChecks()).isClean).toBe(false);

      // And the trigger is back in force.
      await expect(owner.query(`UPDATE ledger_entries SET amount_minor = 1 WHERE id = $1`, [tampered])).rejects.toThrow(
        /append-only/,
      );
    });

    it('a superuser who deletes an entry is caught at the entry that followed it', async () => {
      const victim = await harness.openUserAccount('USD');
      for (const amount of [10n, 20n, 30n]) await harness.fund(victim, amount);
      const ids = (await app.query(`SELECT id::text FROM ledger_entries WHERE account_id = $1 ORDER BY ledger_entries.id`, [victim.accountId])).rows.map(
        (row: { id: string }) => row.id,
      );
      await superuser.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_mutation`);
      await superuser.query(`DELETE FROM ledger_entries WHERE id = $1`, [ids[1]]);
      await superuser.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_mutation`);

      expect(await harness.checks.verifyHashChains(victim.accountId)).toEqual([
        { entryId: BigInt(ids[2]), accountId: victim.accountId, faults: [HashChainFault.PREVIOUS_HASH_MISMATCH] },
      ]);
    });

    it('deleting an account’s LAST entry leaves no successor to break the chain — the cached balance catches it', async () => {
      const victim = await harness.openUserAccount('EUR');
      for (const amount of [10n, 20n]) await harness.fund(victim, amount);
      const ids = (await app.query(`SELECT id::text FROM ledger_entries WHERE account_id = $1 ORDER BY ledger_entries.id`, [victim.accountId])).rows.map(
        (row: { id: string }) => row.id,
      );
      await superuser.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_mutation`);
      await superuser.query(`DELETE FROM ledger_entries WHERE id = $1`, [ids[1]]);
      await superuser.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_mutation`);

      // The chain that remains is internally consistent...
      expect(await harness.checks.verifyHashChains(victim.accountId)).toEqual([]);
      // ...but the cached projection still points at the vanished entry, so reconciliation flags it.
      const mismatches = await harness.checks.findCachedBalanceMismatches();
      expect(mismatches).toContainEqual(
        expect.objectContaining({
          accountId: victim.accountId,
          cachedBalanceMinor: 30n,
          entriesBalanceMinor: 10n,
          cachedBalanceEntryId: BigInt(ids[1]),
          lastEntryId: BigInt(ids[0]),
        }),
      );
    });
  });
});
