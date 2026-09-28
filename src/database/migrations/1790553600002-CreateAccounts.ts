import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The chart of accounts (design §5.1, §5.2, §6.6).
 *
 * - `accounts` exactly as §5.2. **There is no `CHECK (balance_minor >= 0)`**: a
 *   non-negative balance is policy enforced at authorization, not a fact of the
 *   world (design §6.2). Index names are spelled out in full.
 * - `system_account_templates`: the internal accounts every currency gets, as rows,
 *   so adding a currency is data, not code (P8). Provisioning (the ledger module)
 *   crosses templates × currencies × buckets.
 * - An account's identity (code, type, normal side, currency, owner, bucket) never
 *   changes once created: its entries were posted under that identity.
 */
export class CreateAccounts1790553600002 implements MigrationInterface {
  name = 'CreateAccounts1790553600002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE system_account_templates (
        name          TEXT         PRIMARY KEY CHECK (name ~ '^[A-Z_]+(:[A-Z_]+)*$'),
        account_type  account_type NOT NULL,
        normal_side   normal_side  NOT NULL,
        description   TEXT         NOT NULL
      )
    `);
    // FX_POSITION and EQUITY:ROUNDING are equity, so CREDIT-normal (decision 2026-09-28).
    await queryRunner.query(`
      INSERT INTO system_account_templates (name, account_type, normal_side, description) VALUES
        ('BANK',                'ASSET',     'DEBIT',  'Funds we actually hold at a bank'),
        ('PSP_RECEIVABLE',      'ASSET',     'DEBIT',  'Captured by the PSP, not yet settled to us'),
        ('CLEARING',            'ASSET',     'DEBIT',  'Suspense: in transit or not yet attributable'),
        ('FX_POSITION',         'EQUITY',    'CREDIT', 'Our dealing position in this currency'),
        ('REVENUE:FX_SPREAD',   'REVENUE',   'CREDIT', 'Spread earned, per trade'),
        ('EXPENSE:PSP_FEES',    'EXPENSE',   'DEBIT',  'Payment processing fees'),
        ('EXPENSE:PROMOTIONAL', 'EXPENSE',   'DEBIT',  'Funds bonus and demo credit'),
        ('EQUITY:ROUNDING',     'EQUITY',    'CREDIT', 'Rounding residuals that cannot be folded into revenue'),
        ('EXPENSE:WRITE_OFF',   'EXPENSE',   'DEBIT',  'Unrecoverable overdrafts')
    `);
    // Templates change by migration only.
    await queryRunner.query(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON system_account_templates FROM fx_app`,
    );

    await queryRunner.query(`
      CREATE TABLE accounts (
        id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        code                  TEXT         NOT NULL,
        account_type          account_type NOT NULL,
        normal_side           normal_side  NOT NULL,
        wallet_id             UUID         REFERENCES wallets (id),
        currency_code         CHAR(3)      NOT NULL REFERENCES currencies (code),

        balance_minor         BIGINT       NOT NULL DEFAULT 0,
        reserved_minor        BIGINT       NOT NULL DEFAULT 0,
        balance_entry_id      BIGINT,
        version               INTEGER      NOT NULL DEFAULT 0,

        overdraft_limit_minor BIGINT       NOT NULL DEFAULT 0,
        authorizes_balance    BOOLEAN      NOT NULL DEFAULT TRUE,

        bucket                SMALLINT     NOT NULL DEFAULT 0,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

        CONSTRAINT accounts_reserved_sane CHECK (reserved_minor >= 0),
        CONSTRAINT accounts_overdraft_limit_not_negative CHECK (overdraft_limit_minor >= 0),
        CONSTRAINT accounts_bucket_not_negative CHECK (bucket >= 0),
        CONSTRAINT accounts_user_accounts_in_bucket_zero CHECK (wallet_id IS NULL OR bucket = 0)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX accounts_code_bucket_unique ON accounts (code, bucket)`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX accounts_wallet_currency_unique
        ON accounts (wallet_id, currency_code) WHERE wallet_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    await queryRunner.query(`
      CREATE FUNCTION accounts_reject_identity_change() RETURNS trigger AS $$
      BEGIN
        IF NEW.code IS DISTINCT FROM OLD.code
           OR NEW.account_type IS DISTINCT FROM OLD.account_type
           OR NEW.normal_side IS DISTINCT FROM OLD.normal_side
           OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
           OR NEW.bucket IS DISTINCT FROM OLD.bucket
           OR NEW.authorizes_balance IS DISTINCT FROM OLD.authorizes_balance THEN
          RAISE EXCEPTION 'account identity is immutable (account %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER accounts_identity_immutable BEFORE UPDATE ON accounts
        FOR EACH ROW EXECUTE FUNCTION accounts_reject_identity_change()
    `);
    // Accounts are never removed: their entries reference them forever.
    await queryRunner.query(`REVOKE DELETE, TRUNCATE ON accounts FROM fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE accounts`);
    await queryRunner.query(`DROP FUNCTION accounts_reject_identity_change()`);
    await queryRunner.query(`DROP TABLE system_account_templates`);
  }
}
