import { MigrationInterface, QueryRunner } from 'typeorm';

/** Rows that never change once inserted: UPDATE / DELETE / TRUNCATE raise for every role. */
const APPEND_ONLY_TABLES = [
  'customer_stashes',
  'withdrawal_destinations',
  'paystack_transfer_observations',
  'withdrawal_verifications',
  'stash_receipts',
  'withdrawal_accounting_events',
  'withdrawal_review_events',
];

const SEALED = (column: string) => `octet_length(${column}) >= 29`;
const KEY_ID = (column: string) => `${column} ~ '^[A-Za-z0-9._:-]{1,64}$'`;
const CODE = (column: string) => `${column} ~ '^[A-Z][A-Z0-9_]{0,63}$'`;

const BENEFICIARY_MUTABLE = [
  'resolved_account_name_sealed',
  'resolution_evidence_id',
  'resolved_at',
  'provider_recipient_code_sealed',
  'provider_recipient_id_sealed',
  'recipient_evidence_id',
  'recipient_bound_at',
  'failure_code',
];
const WITHDRAWAL_MUTABLE = [
  'reservation_id',
  'submission_started_at',
  'submission_payload_sha256',
  'provider_transfer_id',
  'provider_transfer_code',
  'principal_transaction_id',
  'reversal_transaction_id',
  'confirmation_verification_id',
  'return_verification_id',
  'failure_code',
  'posted_at',
  'failed_at',
  'reversed_at',
];

const without = (columns: readonly string[]) => columns.map((column) => ` - '${column}'`).join('');
const setOnceViolation = (columns: readonly string[]) =>
  columns.map((column) => `(OLD.${column} IS NOT NULL AND NEW.${column} IS DISTINCT FROM OLD.${column})`).join('\n           OR ');

/**
 * Withdrawals and the customer stash, W1 (WITHDRAWAL_PLAN.md §D; D1, D2, D4, D5, D6 approved 2026-10-03).
 *
 * Tables (names spelled out): `withdrawal_beneficiaries` (a prepared destination, sealed PII, keyed fingerprint),
 * `customer_stashes` (one simulated bank per user; no amount, no balance column, no ledger account),
 * `paystack_withdrawals` (the typed intent; money facts live here, never in flow JSON), `withdrawal_destinations`
 * (the destination frozen at admission), `paystack_transfer_observations` (every transfer read, matches AND
 * mismatches), `withdrawal_verifications` (the matched outcome certificate), `stash_receipts` (append-only; the
 * stash balance is DERIVED from them), `withdrawal_accounting_events` (links internal provider-side postings to their
 * evidence), `withdrawal_review_events`.
 *
 * Controls, by construction:
 * - Composite keys bind every fact to its owner, currency and principal: a verification or receipt for another
 *   user, another currency or another amount cannot reference the withdrawal at all.
 * - Insert triggers check what keys cannot: the flow's type and owner, the wallet account (the owner's LIABILITY,
 *   balance-authorizing, in the currency), the frozen destination equals the READY beneficiary, a verification
 *   matches its observation (reference, transfer id/code, amount, currency, recipient fingerprint, test domain), a
 *   SUCCESS certificate comes only from `transfer.verify`, a receipt matches the actual ledger entries (the owner's
 *   account debited, `PAYSTACK_PAYOUT_IN_TRANSIT` in the withdrawal's bucket credited, reference, value time), an
 *   accounting event matches the posting matrix (§F.1) and a fee refund never exceeds the fee.
 * - An observation's time is millisecond-precise (CHECK): an `OBSERVED_TEST_STATE` value time (D4) equals it exactly,
 *   and it must survive the JavaScript `Date` that carries it into `post()`'s `valueTime` unchanged.
 * - `assert_withdrawal_consistent(flow)` runs at COMMIT (deferred constraint triggers on the flow, the withdrawal,
 *   its FLOW_CONTROLLED reservation, receipts, destination and verifications): RESERVED / SUBMITTING / PROCESSING
 *   hold an ACTIVE protected reservation; POSTED ⇔ the reservation SETTLED by exactly the principal posting + a
 *   SUCCESS certificate + exactly one confirmation; FAILED ⇔ RELEASED, no posting, no receipt, and either never sent
 *   or a definitive-failure certificate; REVERSED ⇔ POSTED's facts + the reversal + exactly one reversal receipt.
 *   So a generic `release()` / `settle()` of a payout hold without those facts fails the commit. The approved
 *   late-success recovery proof (§E.2) is W4's amendment of this function.
 * - `fx_app` cannot INSERT into `stash_receipts`: `record_stash_receipt(withdrawal, verification)` (SECURITY DEFINER,
 *   fixed search path) derives owner, amount, kind and posting from validated facts. It never posts money.
 * - Immutable identity everywhere; progression columns set once; `fx_app` has column UPDATE only on those, no
 *   DELETE / TRUNCATE anywhere.
 */
export class CreateWithdrawals1791417600004 implements MigrationInterface {
  name = 'CreateWithdrawals1791417600004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE transfer_status_classification AS ENUM (
        'PENDING', 'OTP', 'RECEIVED', 'SUCCESS', 'FAILED', 'ABANDONED', 'BLOCKED', 'REJECTED', 'REVERSED',
        'NOT_FOUND', 'UNKNOWN', 'MALFORMED')
    `);
    await queryRunner.query(`
      CREATE TYPE transfer_observation_source AS ENUM ('WEBHOOK', 'RESUMER', 'RECONCILIATION', 'SUBMISSION', 'APPROVED_RECOVERY')
    `);
    await queryRunner.query(`CREATE TYPE withdrawal_verification_outcome AS ENUM ('SUCCESS', 'DEFINITIVE_FAILURE', 'FULL_RETURN')`);
    await queryRunner.query(`CREATE TYPE withdrawal_value_time_basis AS ENUM ('PROVIDER_EVENT_TIME', 'OBSERVED_TEST_STATE')`);
    await queryRunner.query(`CREATE TYPE stash_receipt_kind AS ENUM ('CONFIRMATION', 'REVERSAL')`);
    await queryRunner.query(`
      CREATE TYPE withdrawal_accounting_event_kind AS ENUM ('PRINCIPAL_DEBIT', 'PRINCIPAL_RETURN', 'PROVIDER_FEE', 'PROVIDER_FEE_REFUND')
    `);
    await queryRunner.query(`CREATE TYPE withdrawal_evidence_basis AS ENUM ('TRANSFER_STATE', 'BALANCE_LEDGER')`);
    await queryRunner.query(`CREATE TYPE withdrawal_review_event_kind AS ENUM ('OPENED', 'UPDATED', 'RESOLVED')`);
    await queryRunner.query(`
      CREATE TYPE withdrawal_review_reason AS ENUM (
        'PROVIDER_APPROVAL_REQUIRED', 'PROVIDER_RESPONSE_UNRESOLVED', 'TRANSFER_MISMATCH', 'RECIPIENT_IDENTITY_CONFLICT',
        'PROTECTED_HOLD_OVERDUE', 'PERIOD_LOCKED', 'PARTIAL_RETURN', 'TREASURY_EVIDENCE_MISSING', 'FEE_EVIDENCE_MISSING')
    `);
    await queryRunner.query(`CREATE TYPE withdrawal_review_owner AS ENUM ('OPERATIONS', 'SECURITY')`);

    // ── Beneficiaries ───────────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE withdrawal_beneficiaries (
        id                              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                         UUID        NOT NULL REFERENCES users (id),
        flow_id                         UUID        NOT NULL UNIQUE REFERENCES flow_instances (id),
        currency_code                   CHAR(3)     NOT NULL REFERENCES currencies (code),
        recipient_type                  TEXT        NOT NULL DEFAULT 'nuban',
        bank_code                       TEXT        NOT NULL,
        account_number_last_four        CHAR(4)     NOT NULL,
        sealing_key_id                  TEXT        NOT NULL,
        account_number_sealed           BYTEA       NOT NULL,
        identity_fingerprint            BYTEA       NOT NULL,
        identity_fingerprint_key_id     TEXT        NOT NULL,
        provider                        TEXT        NOT NULL DEFAULT 'paystack',
        provider_account_identity       TEXT        NOT NULL,
        environment                     TEXT        NOT NULL DEFAULT 'test',
        resolved_account_name_sealed    BYTEA,
        resolution_evidence_id          UUID        REFERENCES protected_provider_evidence (id),
        resolved_at                     TIMESTAMPTZ,
        provider_recipient_code_sealed  BYTEA,
        provider_recipient_id_sealed    BYTEA,
        recipient_evidence_id           UUID        REFERENCES protected_provider_evidence (id),
        recipient_bound_at              TIMESTAMPTZ,
        failure_code                    TEXT,
        current_review_event_id         UUID,
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT withdrawal_beneficiaries_owner_currency_unique UNIQUE (id, user_id, currency_code),
        CONSTRAINT withdrawal_beneficiaries_currency_ngn CHECK (currency_code = 'NGN'),
        CONSTRAINT withdrawal_beneficiaries_recipient_type_nuban CHECK (recipient_type = 'nuban'),
        CONSTRAINT withdrawal_beneficiaries_bank_code_valid CHECK (bank_code ~ '^[0-9A-Za-z]{1,20}$'),
        CONSTRAINT withdrawal_beneficiaries_last_four_digits CHECK (account_number_last_four ~ '^[0-9]{4}$'),
        CONSTRAINT withdrawal_beneficiaries_key_ids_valid CHECK (${KEY_ID('sealing_key_id')} AND ${KEY_ID('identity_fingerprint_key_id')}),
        CONSTRAINT withdrawal_beneficiaries_sealed_framed CHECK (
          ${SEALED('account_number_sealed')}
          AND (resolved_account_name_sealed IS NULL OR ${SEALED('resolved_account_name_sealed')})
          AND (provider_recipient_code_sealed IS NULL OR ${SEALED('provider_recipient_code_sealed')})
          AND (provider_recipient_id_sealed IS NULL OR ${SEALED('provider_recipient_id_sealed')})
        ),
        CONSTRAINT withdrawal_beneficiaries_fingerprint_length CHECK (octet_length(identity_fingerprint) = 32),
        CONSTRAINT withdrawal_beneficiaries_provider_paystack CHECK (provider = 'paystack'),
        CONSTRAINT withdrawal_beneficiaries_environment_test CHECK (environment = 'test'),
        CONSTRAINT withdrawal_beneficiaries_identity_present CHECK (length(provider_account_identity) BETWEEN 1 AND 64),
        CONSTRAINT withdrawal_beneficiaries_resolution_together CHECK (
          (resolved_account_name_sealed IS NULL) = (resolution_evidence_id IS NULL)
          AND (resolution_evidence_id IS NULL) = (resolved_at IS NULL)
        ),
        CONSTRAINT withdrawal_beneficiaries_recipient_together CHECK (
          (provider_recipient_code_sealed IS NULL) = (provider_recipient_id_sealed IS NULL)
          AND (provider_recipient_id_sealed IS NULL) = (recipient_evidence_id IS NULL)
          AND (recipient_evidence_id IS NULL) = (recipient_bound_at IS NULL)
        ),
        CONSTRAINT withdrawal_beneficiaries_recipient_after_resolution CHECK (recipient_bound_at IS NULL OR resolved_at IS NOT NULL),
        CONSTRAINT withdrawal_beneficiaries_failure_code_valid CHECK (failure_code IS NULL OR ${CODE('failure_code')})
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX withdrawal_beneficiaries_identity_unique
        ON withdrawal_beneficiaries (user_id, identity_fingerprint_key_id, identity_fingerprint)
    `);
    await queryRunner.query(`
      CREATE INDEX withdrawal_beneficiaries_user_created_index ON withdrawal_beneficiaries (user_id, created_at DESC, id DESC)
    `);

    // ── Stashes ─────────────────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE customer_stashes (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID        NOT NULL UNIQUE REFERENCES users (id),
        kind        TEXT        NOT NULL DEFAULT 'SIMULATED_BANK',
        simulated   BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT customer_stashes_owner_unique UNIQUE (id, user_id),
        CONSTRAINT customer_stashes_kind_simulated_bank CHECK (kind = 'SIMULATED_BANK'),
        CONSTRAINT customer_stashes_simulated CHECK (simulated)
      )
    `);

    // ── Withdrawals ─────────────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE paystack_withdrawals (
        flow_id                       UUID        PRIMARY KEY REFERENCES flow_instances (id),
        user_id                       UUID        NOT NULL REFERENCES users (id),
        account_id                    UUID        NOT NULL REFERENCES accounts (id),
        stash_id                      UUID        NOT NULL,
        beneficiary_id                UUID        NOT NULL,
        currency_code                 CHAR(3)     NOT NULL REFERENCES currencies (code),
        principal_minor               BIGINT      NOT NULL,
        customer_fee_minor            BIGINT      NOT NULL DEFAULT 0,
        total_debit_minor             BIGINT      NOT NULL,
        provider                      TEXT        NOT NULL DEFAULT 'paystack',
        provider_account_identity     TEXT        NOT NULL,
        environment                   TEXT        NOT NULL DEFAULT 'test',
        provider_reference            TEXT        NOT NULL,
        internal_bucket               SMALLINT    NOT NULL,
        reservation_id                UUID        UNIQUE REFERENCES reservations (id),
        submission_started_at         TIMESTAMPTZ,
        submission_payload_sha256     BYTEA,
        provider_transfer_id          TEXT,
        provider_transfer_code        TEXT,
        principal_transaction_id      UUID        UNIQUE REFERENCES transactions (id),
        reversal_transaction_id       UUID        UNIQUE REFERENCES transactions (id),
        confirmation_verification_id  UUID,
        return_verification_id        UUID,
        failure_code                  TEXT,
        posted_at                     TIMESTAMPTZ,
        failed_at                     TIMESTAMPTZ,
        reversed_at                   TIMESTAMPTZ,
        current_review_event_id       UUID,
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT paystack_withdrawals_stash_owner_foreign_key
          FOREIGN KEY (stash_id, user_id) REFERENCES customer_stashes (id, user_id),
        CONSTRAINT paystack_withdrawals_beneficiary_owner_foreign_key
          FOREIGN KEY (beneficiary_id, user_id, currency_code) REFERENCES withdrawal_beneficiaries (id, user_id, currency_code),
        CONSTRAINT paystack_withdrawals_owner_currency_unique UNIQUE (flow_id, user_id, currency_code),
        CONSTRAINT paystack_withdrawals_principal_unique UNIQUE (flow_id, user_id, currency_code, principal_minor),
        CONSTRAINT paystack_withdrawals_stash_unique UNIQUE (flow_id, stash_id),
        CONSTRAINT paystack_withdrawals_currency_ngn CHECK (currency_code = 'NGN'),
        CONSTRAINT paystack_withdrawals_principal_positive CHECK (principal_minor > 0),
        CONSTRAINT paystack_withdrawals_customer_fee_zero CHECK (customer_fee_minor = 0),
        CONSTRAINT paystack_withdrawals_total_debit CHECK (total_debit_minor = principal_minor + customer_fee_minor),
        CONSTRAINT paystack_withdrawals_provider_paystack CHECK (provider = 'paystack'),
        CONSTRAINT paystack_withdrawals_environment_test CHECK (environment = 'test'),
        CONSTRAINT paystack_withdrawals_identity_present CHECK (length(provider_account_identity) BETWEEN 1 AND 64),
        CONSTRAINT paystack_withdrawals_reference_derived CHECK (
          provider_reference = 'withdrawal-' || flow_id::text
          AND provider_reference ~ '^withdrawal-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ),
        CONSTRAINT paystack_withdrawals_bucket_non_negative CHECK (internal_bucket >= 0),
        CONSTRAINT paystack_withdrawals_submission_together CHECK (
          (submission_started_at IS NULL) = (submission_payload_sha256 IS NULL)
          AND (submission_payload_sha256 IS NULL OR octet_length(submission_payload_sha256) = 32)
        ),
        CONSTRAINT paystack_withdrawals_transfer_together CHECK (
          (provider_transfer_id IS NULL) = (provider_transfer_code IS NULL)
          AND (provider_transfer_id IS NULL OR provider_transfer_id ~ '^[0-9]{1,30}$')
          AND (provider_transfer_code IS NULL OR provider_transfer_code ~ '^TRF_[A-Za-z0-9]{1,64}$')
        ),
        CONSTRAINT paystack_withdrawals_transfer_after_submission CHECK (provider_transfer_id IS NULL OR submission_started_at IS NOT NULL),
        CONSTRAINT paystack_withdrawals_posted_together CHECK (
          (principal_transaction_id IS NULL) = (posted_at IS NULL)
          AND (posted_at IS NULL) = (confirmation_verification_id IS NULL)
          AND (posted_at IS NULL OR submission_started_at IS NOT NULL)
        ),
        CONSTRAINT paystack_withdrawals_reversed_together CHECK (
          (reversal_transaction_id IS NULL) = (reversed_at IS NULL)
          AND (reversed_at IS NULL) = (return_verification_id IS NULL)
          AND (reversed_at IS NULL OR posted_at IS NOT NULL)
        ),
        CONSTRAINT paystack_withdrawals_failed_together CHECK (
          (failed_at IS NULL) = (failure_code IS NULL)
          AND (failed_at IS NULL OR posted_at IS NULL)
          AND (failure_code IS NULL OR ${CODE('failure_code')})
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX paystack_withdrawals_reference_unique
        ON paystack_withdrawals (provider, provider_account_identity, environment, provider_reference)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX paystack_withdrawals_transfer_id_unique
        ON paystack_withdrawals (provider, provider_account_identity, environment, provider_transfer_id)
        WHERE provider_transfer_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX paystack_withdrawals_transfer_code_unique
        ON paystack_withdrawals (provider, provider_account_identity, environment, provider_transfer_code)
        WHERE provider_transfer_code IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX paystack_withdrawals_unposted_user_index ON paystack_withdrawals (user_id, created_at DESC, flow_id DESC)
        WHERE posted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX paystack_withdrawals_unposted_user_currency_index
        ON paystack_withdrawals (user_id, currency_code, created_at DESC, flow_id DESC) WHERE posted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX paystack_withdrawals_outstanding_account_index ON paystack_withdrawals (account_id)
        INCLUDE (principal_minor) WHERE posted_at IS NULL AND failed_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX paystack_withdrawals_completion_index ON paystack_withdrawals (account_id, posted_at, flow_id)
        INCLUDE (principal_minor) WHERE posted_at IS NOT NULL
    `);

    // ── Frozen destinations ─────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE withdrawal_destinations (
        withdrawal_id                   UUID        PRIMARY KEY,
        user_id                         UUID        NOT NULL,
        currency_code                   CHAR(3)     NOT NULL,
        beneficiary_id                  UUID        NOT NULL,
        recipient_type                  TEXT        NOT NULL,
        bank_code                       TEXT        NOT NULL,
        bank_name                       TEXT        NOT NULL,
        account_number_last_four        CHAR(4)     NOT NULL,
        sealing_key_id                  TEXT        NOT NULL,
        account_number_sealed           BYTEA       NOT NULL,
        resolved_account_name_sealed    BYTEA       NOT NULL,
        provider_recipient_code_sealed  BYTEA       NOT NULL,
        provider_recipient_id_sealed    BYTEA       NOT NULL,
        identity_fingerprint            BYTEA       NOT NULL,
        identity_fingerprint_key_id     TEXT        NOT NULL,
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT withdrawal_destinations_withdrawal_foreign_key
          FOREIGN KEY (withdrawal_id, user_id, currency_code) REFERENCES paystack_withdrawals (flow_id, user_id, currency_code),
        CONSTRAINT withdrawal_destinations_beneficiary_foreign_key
          FOREIGN KEY (beneficiary_id, user_id, currency_code) REFERENCES withdrawal_beneficiaries (id, user_id, currency_code),
        CONSTRAINT withdrawal_destinations_bank_name_present CHECK (length(bank_name) BETWEEN 1 AND 100)
      )
    `);

    // ── Transfer observations ───────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE paystack_transfer_observations (
        id                                      UUID                           PRIMARY KEY DEFAULT gen_random_uuid(),
        withdrawal_id                           UUID                           REFERENCES paystack_withdrawals (flow_id),
        provider                                TEXT                           NOT NULL DEFAULT 'paystack',
        provider_account_identity               TEXT                           NOT NULL,
        environment                             TEXT                           NOT NULL DEFAULT 'test',
        operation                               TEXT                           NOT NULL,
        observed_domain                         TEXT,
        provider_reference                      TEXT,
        provider_transfer_id                    TEXT,
        provider_transfer_code                  TEXT,
        status_classification                   transfer_status_classification NOT NULL,
        raw_status                              TEXT,
        amount_minor                            BIGINT,
        currency_code                           TEXT,
        recipient_identity_fingerprint          BYTEA,
        recipient_identity_fingerprint_key_id   TEXT,
        provider_created_at                     TIMESTAMPTZ,
        provider_updated_at                     TIMESTAMPTZ,
        provider_transferred_at                 TIMESTAMPTZ,
        fee_charged_minor                       BIGINT,
        evidence_id                             UUID                           NOT NULL REFERENCES protected_provider_evidence (id),
        request_sha256                          BYTEA,
        response_sha256                         BYTEA                          NOT NULL,
        source                                  transfer_observation_source    NOT NULL,
        webhook_event_id                        UUID                           REFERENCES webhook_events (id),
        reconciliation_run_id                   UUID                           REFERENCES reconciliation_runs (id),
        approval_id                             UUID                           REFERENCES approvals (id),
        observed_at                             TIMESTAMPTZ                    NOT NULL DEFAULT date_trunc('milliseconds', now()),

        CONSTRAINT paystack_transfer_observations_observed_milliseconds CHECK (observed_at = date_trunc('milliseconds', observed_at)),
        CONSTRAINT paystack_transfer_observations_provider_paystack CHECK (provider = 'paystack'),
        CONSTRAINT paystack_transfer_observations_environment_test CHECK (environment = 'test'),
        CONSTRAINT paystack_transfer_observations_identity_present CHECK (length(provider_account_identity) BETWEEN 1 AND 64),
        CONSTRAINT paystack_transfer_observations_operation_valid CHECK (
          operation IN ('transfer.initiate', 'transfer.verify', 'transfer.fetch', 'transfer.list', 'webhook.transfer')
        ),
        CONSTRAINT paystack_transfer_observations_raw_bounded CHECK (
          length(observed_domain) <= 16 AND length(provider_reference) <= 100 AND length(provider_transfer_code) <= 100
          AND length(raw_status) <= 64
        ),
        CONSTRAINT paystack_transfer_observations_transfer_id_digits CHECK (provider_transfer_id ~ '^[0-9]{1,30}$'),
        CONSTRAINT paystack_transfer_observations_currency_shape CHECK (currency_code ~ '^[A-Z]{3}$'),
        CONSTRAINT paystack_transfer_observations_fee_non_negative CHECK (fee_charged_minor >= 0),
        CONSTRAINT paystack_transfer_observations_recipient_together CHECK (
          (recipient_identity_fingerprint IS NULL) = (recipient_identity_fingerprint_key_id IS NULL)
          AND (recipient_identity_fingerprint IS NULL OR octet_length(recipient_identity_fingerprint) = 32)
        ),
        CONSTRAINT paystack_transfer_observations_digests CHECK (
          octet_length(response_sha256) = 32 AND (request_sha256 IS NULL OR octet_length(request_sha256) = 32)
        ),
        CONSTRAINT paystack_transfer_observations_source_shape CHECK (
          (source = 'WEBHOOK') = (webhook_event_id IS NOT NULL)
          AND (source = 'RECONCILIATION') = (reconciliation_run_id IS NOT NULL)
          AND (source = 'APPROVED_RECOVERY') = (approval_id IS NOT NULL)
          AND (source = 'WEBHOOK') = (operation = 'webhook.transfer')
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX paystack_transfer_observations_withdrawal_index ON paystack_transfer_observations (withdrawal_id, observed_at)
    `);
    await queryRunner.query(`
      CREATE INDEX paystack_transfer_observations_reference_index
        ON paystack_transfer_observations (provider_account_identity, environment, provider_reference)
    `);

    // ── Verifications ───────────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE withdrawal_verifications (
        id                UUID                            PRIMARY KEY DEFAULT gen_random_uuid(),
        withdrawal_id     UUID                            NOT NULL REFERENCES withdrawal_destinations (withdrawal_id),
        user_id           UUID                            NOT NULL,
        currency_code     CHAR(3)                         NOT NULL,
        amount_minor      BIGINT                          NOT NULL,
        observation_id    UUID                            NOT NULL UNIQUE REFERENCES paystack_transfer_observations (id),
        outcome           withdrawal_verification_outcome NOT NULL,
        value_time        TIMESTAMPTZ                     NOT NULL,
        value_time_basis  withdrawal_value_time_basis     NOT NULL,
        recorded_at       TIMESTAMPTZ                     NOT NULL DEFAULT now(),

        CONSTRAINT withdrawal_verifications_principal_foreign_key
          FOREIGN KEY (withdrawal_id, user_id, currency_code, amount_minor)
          REFERENCES paystack_withdrawals (flow_id, user_id, currency_code, principal_minor),
        CONSTRAINT withdrawal_verifications_fact_unique UNIQUE (id, withdrawal_id, user_id, currency_code, amount_minor),
        CONSTRAINT withdrawal_verifications_outcome_unique UNIQUE (withdrawal_id, outcome)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE paystack_withdrawals
        ADD CONSTRAINT paystack_withdrawals_confirmation_foreign_key
          FOREIGN KEY (confirmation_verification_id) REFERENCES withdrawal_verifications (id),
        ADD CONSTRAINT paystack_withdrawals_return_foreign_key
          FOREIGN KEY (return_verification_id) REFERENCES withdrawal_verifications (id)
    `);

    // ── Stash receipts ──────────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE stash_receipts (
        id                     UUID                        PRIMARY KEY DEFAULT gen_random_uuid(),
        stash_id               UUID                        NOT NULL,
        user_id                UUID                        NOT NULL,
        withdrawal_id          UUID                        NOT NULL REFERENCES withdrawal_destinations (withdrawal_id),
        currency_code          CHAR(3)                     NOT NULL,
        amount_minor           BIGINT                      NOT NULL,
        event_kind             stash_receipt_kind          NOT NULL,
        verification_id        UUID                        NOT NULL,
        ledger_transaction_id  UUID                        NOT NULL UNIQUE REFERENCES transactions (id),
        value_time             TIMESTAMPTZ                 NOT NULL,
        value_time_basis       withdrawal_value_time_basis NOT NULL,
        reverses_receipt_id    UUID                        UNIQUE REFERENCES stash_receipts (id),
        recorded_at            TIMESTAMPTZ                 NOT NULL DEFAULT now(),

        CONSTRAINT stash_receipts_stash_owner_foreign_key FOREIGN KEY (stash_id, user_id) REFERENCES customer_stashes (id, user_id),
        CONSTRAINT stash_receipts_withdrawal_stash_foreign_key
          FOREIGN KEY (withdrawal_id, stash_id) REFERENCES paystack_withdrawals (flow_id, stash_id),
        CONSTRAINT stash_receipts_principal_foreign_key
          FOREIGN KEY (withdrawal_id, user_id, currency_code, amount_minor)
          REFERENCES paystack_withdrawals (flow_id, user_id, currency_code, principal_minor),
        CONSTRAINT stash_receipts_verification_foreign_key
          FOREIGN KEY (verification_id, withdrawal_id, user_id, currency_code, amount_minor)
          REFERENCES withdrawal_verifications (id, withdrawal_id, user_id, currency_code, amount_minor),
        CONSTRAINT stash_receipts_kind_unique UNIQUE (withdrawal_id, event_kind),
        CONSTRAINT stash_receipts_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT stash_receipts_reversal_link CHECK ((event_kind = 'REVERSAL') = (reverses_receipt_id IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX stash_receipts_user_recorded_index ON stash_receipts (user_id, recorded_at DESC, id DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX stash_receipts_user_currency_recorded_index ON stash_receipts (user_id, currency_code, recorded_at DESC, id DESC)
    `);

    // ── Accounting events ───────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE withdrawal_accounting_events (
        id                       UUID                             PRIMARY KEY DEFAULT gen_random_uuid(),
        withdrawal_id            UUID                             NOT NULL REFERENCES paystack_withdrawals (flow_id),
        event_kind               withdrawal_accounting_event_kind NOT NULL,
        currency_code            CHAR(3)                          NOT NULL REFERENCES currencies (code),
        amount_minor             BIGINT                           NOT NULL,
        transaction_id           UUID                             NOT NULL UNIQUE REFERENCES transactions (id),
        evidence_basis           withdrawal_evidence_basis        NOT NULL,
        observation_id           UUID                             REFERENCES paystack_transfer_observations (id),
        balance_ledger_row_id    UUID                             REFERENCES paystack_balance_ledger_rows (id),
        original_event_id        UUID                             REFERENCES withdrawal_accounting_events (id),
        provider_event_identity  TEXT                             NOT NULL,
        fee_component            TEXT,
        recorded_at              TIMESTAMPTZ                      NOT NULL DEFAULT now(),

        CONSTRAINT withdrawal_accounting_events_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT withdrawal_accounting_events_evidence_shape CHECK (
          (evidence_basis <> 'TRANSFER_STATE' OR observation_id IS NOT NULL)
          AND (evidence_basis <> 'BALANCE_LEDGER' OR balance_ledger_row_id IS NOT NULL)
        ),
        CONSTRAINT withdrawal_accounting_events_original_shape CHECK (
          (event_kind IN ('PRINCIPAL_RETURN', 'PROVIDER_FEE_REFUND')) = (original_event_id IS NOT NULL)
        ),
        CONSTRAINT withdrawal_accounting_events_fee_component_shape CHECK (
          (event_kind IN ('PROVIDER_FEE', 'PROVIDER_FEE_REFUND')) = (fee_component IS NOT NULL)
          AND (fee_component IS NULL OR fee_component ~ '^[a-z][a-z0-9_]{0,31}$')
        ),
        CONSTRAINT withdrawal_accounting_events_identity_bounded CHECK (length(provider_event_identity) BETWEEN 1 AND 128)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX withdrawal_accounting_events_principal_debit_unique ON withdrawal_accounting_events (withdrawal_id)
        WHERE event_kind = 'PRINCIPAL_DEBIT'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX withdrawal_accounting_events_principal_return_unique ON withdrawal_accounting_events (withdrawal_id)
        WHERE event_kind = 'PRINCIPAL_RETURN'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX withdrawal_accounting_events_fee_unique
        ON withdrawal_accounting_events (withdrawal_id, event_kind, provider_event_identity, fee_component)
        WHERE event_kind IN ('PROVIDER_FEE', 'PROVIDER_FEE_REFUND')
    `);

    // ── Review events ───────────────────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE withdrawal_review_events (
        id                 UUID                         PRIMARY KEY DEFAULT gen_random_uuid(),
        flow_id            UUID                         NOT NULL REFERENCES flow_instances (id),
        event_kind         withdrawal_review_event_kind NOT NULL,
        reason             withdrawal_review_reason     NOT NULL,
        owner              withdrawal_review_owner      NOT NULL,
        observation_id     UUID                         REFERENCES paystack_transfer_observations (id),
        evidence_id        UUID                         REFERENCES protected_provider_evidence (id),
        previous_event_id  UUID                         REFERENCES withdrawal_review_events (id),
        actor              TEXT                         NOT NULL,
        recorded_at        TIMESTAMPTZ                  NOT NULL DEFAULT now(),

        CONSTRAINT withdrawal_review_events_actor_valid CHECK (actor ~ '^(job|operator):[A-Za-z0-9:._-]{1,100}$'),
        CONSTRAINT withdrawal_review_events_chain_shape CHECK ((event_kind = 'OPENED') = (previous_event_id IS NULL))
      )
    `);
    await queryRunner.query(`CREATE INDEX withdrawal_review_events_flow_index ON withdrawal_review_events (flow_id, recorded_at)`);
    await queryRunner.query(`
      ALTER TABLE withdrawal_beneficiaries ADD CONSTRAINT withdrawal_beneficiaries_review_foreign_key
        FOREIGN KEY (current_review_event_id) REFERENCES withdrawal_review_events (id)
    `);
    await queryRunner.query(`
      ALTER TABLE paystack_withdrawals ADD CONSTRAINT paystack_withdrawals_review_foreign_key
        FOREIGN KEY (current_review_event_id) REFERENCES withdrawal_review_events (id)
    `);

    await this.createInsertChecks(queryRunner);
    await this.createMutationGuards(queryRunner);
    await this.createConsistencyChecks(queryRunner);
    await this.createReceiptFunction(queryRunner);
  }

  /** What composite keys cannot express, checked when the row is inserted. */
  private async createInsertChecks(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION withdrawal_beneficiaries_check_insert() RETURNS trigger AS $$
      DECLARE
        flow flow_instances%ROWTYPE;
      BEGIN
        SELECT * INTO flow FROM flow_instances WHERE id = NEW.flow_id;
        IF flow.flow_type IS DISTINCT FROM 'PAYSTACK_BENEFICIARY' OR flow.user_id IS DISTINCT FROM NEW.user_id THEN
          RAISE EXCEPTION 'beneficiary % must belong to its owner''s PAYSTACK_BENEFICIARY flow', NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.resolved_at IS NOT NULL OR NEW.recipient_bound_at IS NOT NULL OR NEW.failure_code IS NOT NULL
           OR NEW.current_review_event_id IS NOT NULL THEN
          RAISE EXCEPTION 'beneficiary % starts unresolved', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER withdrawal_beneficiaries_check_insert BEFORE INSERT ON withdrawal_beneficiaries
        FOR EACH ROW EXECUTE FUNCTION withdrawal_beneficiaries_check_insert()
    `);

    await queryRunner.query(`
      CREATE FUNCTION paystack_withdrawals_check_insert() RETURNS trigger AS $$
      DECLARE
        flow flow_instances%ROWTYPE;
      BEGIN
        SELECT * INTO flow FROM flow_instances WHERE id = NEW.flow_id;
        IF flow.flow_type IS DISTINCT FROM 'PAYSTACK_WITHDRAWAL' OR flow.user_id IS DISTINCT FROM NEW.user_id THEN
          RAISE EXCEPTION 'withdrawal % must belong to its owner''s PAYSTACK_WITHDRAWAL flow', NEW.flow_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
           WHERE accounts.id = NEW.account_id AND wallets.user_id = NEW.user_id
             AND accounts.currency_code = NEW.currency_code AND accounts.account_type = 'LIABILITY'
             AND accounts.authorizes_balance
        ) THEN
          RAISE EXCEPTION 'withdrawal % must debit its owner''s % wallet account', NEW.flow_id, NEW.currency_code
            USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM accounts
           WHERE code = 'PAYSTACK_PAYOUT_IN_TRANSIT:' || NEW.currency_code AND bucket = NEW.internal_bucket
             AND wallet_id IS NULL
        ) THEN
          RAISE EXCEPTION 'withdrawal % names internal bucket %, which is not provisioned', NEW.flow_id, NEW.internal_bucket
            USING ERRCODE = 'check_violation';
        END IF;
        IF num_nonnulls(NEW.reservation_id, NEW.submission_started_at, NEW.provider_transfer_id, NEW.principal_transaction_id,
                        NEW.reversal_transaction_id, NEW.confirmation_verification_id, NEW.return_verification_id,
                        NEW.failure_code, NEW.posted_at, NEW.failed_at, NEW.reversed_at, NEW.current_review_event_id) > 0 THEN
          RAISE EXCEPTION 'withdrawal % starts with no progression', NEW.flow_id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER paystack_withdrawals_check_insert BEFORE INSERT ON paystack_withdrawals
        FOR EACH ROW EXECUTE FUNCTION paystack_withdrawals_check_insert()
    `);

    await queryRunner.query(`
      CREATE FUNCTION withdrawal_destinations_check_insert() RETURNS trigger AS $$
      DECLARE
        withdrawal  paystack_withdrawals%ROWTYPE;
        beneficiary withdrawal_beneficiaries%ROWTYPE;
        state       TEXT;
      BEGIN
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = NEW.withdrawal_id;
        SELECT * INTO beneficiary FROM withdrawal_beneficiaries WHERE id = NEW.beneficiary_id;
        SELECT flow_instances.state INTO state FROM flow_instances WHERE id = beneficiary.flow_id;
        IF withdrawal.beneficiary_id IS DISTINCT FROM NEW.beneficiary_id THEN
          RAISE EXCEPTION 'destination of withdrawal % must be its own beneficiary', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF state IS DISTINCT FROM 'READY' THEN
          RAISE EXCEPTION 'beneficiary % is not READY (%)', NEW.beneficiary_id, state USING ERRCODE = 'check_violation';
        END IF;
        IF (NEW.recipient_type, NEW.bank_code, NEW.account_number_last_four, NEW.sealing_key_id, NEW.account_number_sealed,
            NEW.resolved_account_name_sealed, NEW.provider_recipient_code_sealed, NEW.provider_recipient_id_sealed,
            NEW.identity_fingerprint, NEW.identity_fingerprint_key_id)
           IS DISTINCT FROM
           (beneficiary.recipient_type, beneficiary.bank_code, beneficiary.account_number_last_four, beneficiary.sealing_key_id,
            beneficiary.account_number_sealed, beneficiary.resolved_account_name_sealed,
            beneficiary.provider_recipient_code_sealed, beneficiary.provider_recipient_id_sealed,
            beneficiary.identity_fingerprint, beneficiary.identity_fingerprint_key_id) THEN
          RAISE EXCEPTION 'destination of withdrawal % must be exactly its READY beneficiary', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER withdrawal_destinations_check_insert BEFORE INSERT ON withdrawal_destinations
        FOR EACH ROW EXECUTE FUNCTION withdrawal_destinations_check_insert()
    `);

    await queryRunner.query(`
      CREATE FUNCTION paystack_transfer_observations_check_insert() RETURNS trigger AS $$
      DECLARE
        withdrawal paystack_withdrawals%ROWTYPE;
      BEGIN
        IF NEW.withdrawal_id IS NOT NULL THEN
          SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = NEW.withdrawal_id;
          IF (NEW.provider, NEW.provider_account_identity, NEW.environment, NEW.provider_reference)
             IS DISTINCT FROM (withdrawal.provider, withdrawal.provider_account_identity, withdrawal.environment,
                               withdrawal.provider_reference) THEN
            RAISE EXCEPTION 'an observation bound to withdrawal % must carry its reference and namespace', NEW.withdrawal_id
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER paystack_transfer_observations_check_insert BEFORE INSERT ON paystack_transfer_observations
        FOR EACH ROW EXECUTE FUNCTION paystack_transfer_observations_check_insert()
    `);

    await queryRunner.query(`
      CREATE FUNCTION withdrawal_verifications_check_insert() RETURNS trigger AS $$
      DECLARE
        withdrawal  paystack_withdrawals%ROWTYPE;
        destination withdrawal_destinations%ROWTYPE;
        observation paystack_transfer_observations%ROWTYPE;
      BEGIN
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = NEW.withdrawal_id;
        SELECT * INTO destination FROM withdrawal_destinations WHERE withdrawal_id = NEW.withdrawal_id;
        SELECT * INTO observation FROM paystack_transfer_observations WHERE id = NEW.observation_id;

        IF observation.withdrawal_id IS DISTINCT FROM NEW.withdrawal_id THEN
          RAISE EXCEPTION 'verification of withdrawal % must cite an observation bound to it', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF withdrawal.submission_started_at IS NULL THEN
          RAISE EXCEPTION 'withdrawal % was never authorized for sending; it has no outcome to verify', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF observation.observed_domain IS DISTINCT FROM 'test' THEN
          RAISE EXCEPTION 'verification of withdrawal % needs a test-domain observation (saw %)', NEW.withdrawal_id,
            observation.observed_domain USING ERRCODE = 'check_violation';
        END IF;
        IF observation.amount_minor IS DISTINCT FROM withdrawal.principal_minor
           OR observation.currency_code IS DISTINCT FROM withdrawal.currency_code::text THEN
          RAISE EXCEPTION 'verification of withdrawal % needs the exact principal and currency', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF (observation.recipient_identity_fingerprint, observation.recipient_identity_fingerprint_key_id)
           IS DISTINCT FROM (destination.identity_fingerprint, destination.identity_fingerprint_key_id) THEN
          RAISE EXCEPTION 'verification of withdrawal % needs the frozen recipient identity', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF withdrawal.provider_transfer_id IS NOT NULL
           AND (observation.provider_transfer_id, observation.provider_transfer_code)
               IS DISTINCT FROM (withdrawal.provider_transfer_id, withdrawal.provider_transfer_code) THEN
          RAISE EXCEPTION 'verification of withdrawal % names a different transfer', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.outcome IN ('SUCCESS', 'FULL_RETURN') THEN
          IF observation.operation <> 'transfer.verify' THEN
            RAISE EXCEPTION 'a % certificate comes only from transfer.verify (got %)', NEW.outcome, observation.operation
              USING ERRCODE = 'check_violation';
          END IF;
          IF withdrawal.provider_transfer_id IS NULL THEN
            RAISE EXCEPTION 'withdrawal % has no bound transfer to verify', NEW.withdrawal_id USING ERRCODE = 'check_violation';
          END IF;
        ELSIF observation.operation NOT IN ('transfer.verify', 'transfer.initiate') THEN
          RAISE EXCEPTION 'a definitive failure comes only from transfer.verify or transfer.initiate (got %)', observation.operation
            USING ERRCODE = 'check_violation';
        END IF;

        IF (NEW.outcome = 'SUCCESS' AND observation.status_classification <> 'SUCCESS')
           OR (NEW.outcome = 'FULL_RETURN' AND observation.status_classification <> 'REVERSED')
           OR (NEW.outcome = 'DEFINITIVE_FAILURE'
               AND observation.status_classification NOT IN ('FAILED', 'ABANDONED', 'BLOCKED', 'REJECTED', 'REVERSED')) THEN
          RAISE EXCEPTION 'a % certificate cannot rest on a % observation', NEW.outcome, observation.status_classification
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.outcome = 'SUCCESS' AND EXISTS (
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'DEFINITIVE_FAILURE')
           OR NEW.outcome = 'DEFINITIVE_FAILURE' AND EXISTS (
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'SUCCESS') THEN
          RAISE EXCEPTION 'withdrawal % already has a contradictory certificate; this needs review', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.outcome = 'FULL_RETURN' AND NOT EXISTS (
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'SUCCESS') THEN
          RAISE EXCEPTION 'a full return of withdrawal % needs its verified success first', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.value_time_basis = 'PROVIDER_EVENT_TIME' THEN
          IF NEW.outcome <> 'SUCCESS' OR observation.provider_transferred_at IS NULL
             OR NEW.value_time IS DISTINCT FROM observation.provider_transferred_at THEN
            RAISE EXCEPTION 'a provider event time is the success''s transferred_at, exactly' USING ERRCODE = 'check_violation';
          END IF;
        ELSIF withdrawal.environment <> 'test' OR NEW.value_time IS DISTINCT FROM observation.observed_at THEN
          RAISE EXCEPTION 'an observed test-state time is the matched observation''s time, exactly' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER withdrawal_verifications_check_insert BEFORE INSERT ON withdrawal_verifications
        FOR EACH ROW EXECUTE FUNCTION withdrawal_verifications_check_insert()
    `);

    // A receipt matches the posting it cites, entry for entry.
    await queryRunner.query(`
      CREATE FUNCTION stash_receipts_check_insert() RETURNS trigger AS $$
      DECLARE
        withdrawal    paystack_withdrawals%ROWTYPE;
        verification  withdrawal_verifications%ROWTYPE;
        posting       transactions%ROWTYPE;
        in_transit    UUID;
        confirmation  stash_receipts%ROWTYPE;
        user_side     entry_direction;
      BEGIN
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = NEW.withdrawal_id;
        SELECT * INTO verification FROM withdrawal_verifications WHERE id = NEW.verification_id;
        SELECT * INTO posting FROM transactions WHERE id = NEW.ledger_transaction_id;
        SELECT id INTO in_transit FROM accounts
         WHERE code = 'PAYSTACK_PAYOUT_IN_TRANSIT:' || withdrawal.currency_code AND bucket = withdrawal.internal_bucket
           AND wallet_id IS NULL;

        IF NEW.event_kind = 'CONFIRMATION' THEN
          IF verification.outcome <> 'SUCCESS' OR withdrawal.confirmation_verification_id IS DISTINCT FROM verification.id
             OR withdrawal.principal_transaction_id IS DISTINCT FROM NEW.ledger_transaction_id
             OR posting.type <> 'WITHDRAWAL' OR posting.reference <> 'withdrawal:' || withdrawal.flow_id::text THEN
            RAISE EXCEPTION 'a confirmation of withdrawal % needs its verified success and principal posting', NEW.withdrawal_id
              USING ERRCODE = 'check_violation';
          END IF;
          user_side := 'DEBIT';
        ELSE
          SELECT * INTO confirmation FROM stash_receipts WHERE withdrawal_id = NEW.withdrawal_id AND event_kind = 'CONFIRMATION';
          IF verification.outcome <> 'FULL_RETURN' OR withdrawal.return_verification_id IS DISTINCT FROM verification.id
             OR withdrawal.reversal_transaction_id IS DISTINCT FROM NEW.ledger_transaction_id
             OR posting.type <> 'REVERSAL' OR posting.reference <> 'withdrawal-reversal:' || withdrawal.flow_id::text
             OR posting.corrects_transaction_id IS DISTINCT FROM withdrawal.principal_transaction_id
             OR confirmation.id IS NULL OR NEW.reverses_receipt_id IS DISTINCT FROM confirmation.id THEN
            RAISE EXCEPTION 'a reversal of withdrawal % needs its full return, its reversal posting and its confirmation',
              NEW.withdrawal_id USING ERRCODE = 'check_violation';
          END IF;
          user_side := 'CREDIT';
        END IF;

        IF (NEW.value_time, NEW.value_time_basis) IS DISTINCT FROM (verification.value_time, verification.value_time_basis)
           OR posting.value_time IS DISTINCT FROM verification.value_time THEN
          RAISE EXCEPTION 'receipt of withdrawal % must carry its verification''s value time', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF posting.user_id IS DISTINCT FROM NEW.user_id OR posting.status NOT IN ('POSTED', 'REVERSED') THEN
          RAISE EXCEPTION 'receipt of withdrawal % must cite its owner''s posted transaction', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;

        IF (SELECT count(*) FROM ledger_entries WHERE transaction_id = posting.id) <> 2
           OR NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = posting.id AND account_id = withdrawal.account_id
                             AND direction = user_side AND amount_minor = NEW.amount_minor AND currency_code = NEW.currency_code)
           OR NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = posting.id AND account_id = in_transit
                             AND direction <> user_side AND amount_minor = NEW.amount_minor AND currency_code = NEW.currency_code) THEN
          RAISE EXCEPTION 'receipt of withdrawal % does not match its posting''s entries', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER stash_receipts_check_insert BEFORE INSERT ON stash_receipts
        FOR EACH ROW EXECUTE FUNCTION stash_receipts_check_insert()
    `);

    // An accounting event matches the §F.1 matrix: two entries, the withdrawal's bucket, the event's own reference.
    await queryRunner.query(`
      CREATE FUNCTION withdrawal_accounting_events_check_insert() RETURNS trigger AS $$
      DECLARE
        withdrawal  paystack_withdrawals%ROWTYPE;
        posting     transactions%ROWTYPE;
        original    withdrawal_accounting_events%ROWTYPE;
        debit_code  TEXT;
        credit_code TEXT;
        prefix      TEXT;
        refunded    BIGINT;
      BEGIN
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = NEW.withdrawal_id;
        SELECT * INTO posting FROM transactions WHERE id = NEW.transaction_id;

        IF NEW.currency_code <> withdrawal.currency_code THEN
          RAISE EXCEPTION 'accounting event of withdrawal % must be in its currency', NEW.withdrawal_id USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.observation_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM paystack_transfer_observations WHERE id = NEW.observation_id AND withdrawal_id = NEW.withdrawal_id) THEN
          RAISE EXCEPTION 'accounting event of withdrawal % must cite its own observation', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;

        CASE NEW.event_kind
          WHEN 'PRINCIPAL_DEBIT' THEN
            debit_code := 'PAYSTACK_PAYOUT_IN_TRANSIT'; credit_code := 'PAYSTACK_PAYOUT_BALANCE';
            prefix := 'withdrawal-provider-debit:' || withdrawal.flow_id::text;
          WHEN 'PRINCIPAL_RETURN' THEN
            debit_code := 'PAYSTACK_PAYOUT_BALANCE'; credit_code := 'PAYSTACK_PAYOUT_IN_TRANSIT';
            prefix := 'withdrawal-provider-return:' || withdrawal.flow_id::text;
          WHEN 'PROVIDER_FEE' THEN
            debit_code := 'EXPENSE:PAYSTACK_TRANSFER_FEES'; credit_code := 'PAYSTACK_PAYOUT_BALANCE';
            prefix := 'withdrawal-provider-fee:' || withdrawal.flow_id::text || ':';
          WHEN 'PROVIDER_FEE_REFUND' THEN
            debit_code := 'PAYSTACK_PAYOUT_BALANCE'; credit_code := 'EXPENSE:PAYSTACK_TRANSFER_FEES';
            prefix := 'withdrawal-provider-fee-refund:' || withdrawal.flow_id::text || ':';
        END CASE;

        IF NEW.event_kind IN ('PRINCIPAL_DEBIT', 'PRINCIPAL_RETURN') THEN
          IF NEW.amount_minor <> withdrawal.principal_minor OR posting.reference IS DISTINCT FROM prefix THEN
            RAISE EXCEPTION 'a % of withdrawal % is its exact principal under its own reference', NEW.event_kind, NEW.withdrawal_id
              USING ERRCODE = 'check_violation';
          END IF;
        ELSIF left(posting.reference, length(prefix)) IS DISTINCT FROM prefix OR length(posting.reference) = length(prefix) THEN
          RAISE EXCEPTION 'a % of withdrawal % needs a reference under %', NEW.event_kind, NEW.withdrawal_id, prefix
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.original_event_id IS NOT NULL THEN
          SELECT * INTO original FROM withdrawal_accounting_events WHERE id = NEW.original_event_id;
          IF original.withdrawal_id IS DISTINCT FROM NEW.withdrawal_id
             OR (NEW.event_kind = 'PRINCIPAL_RETURN' AND original.event_kind <> 'PRINCIPAL_DEBIT')
             OR (NEW.event_kind = 'PROVIDER_FEE_REFUND'
                 AND (original.event_kind <> 'PROVIDER_FEE' OR original.fee_component IS DISTINCT FROM NEW.fee_component)) THEN
            RAISE EXCEPTION 'a % of withdrawal % must link the event it returns', NEW.event_kind, NEW.withdrawal_id
              USING ERRCODE = 'check_violation';
          END IF;
          IF NEW.event_kind = 'PROVIDER_FEE_REFUND' THEN
            SELECT coalesce(sum(amount_minor), 0) INTO refunded FROM withdrawal_accounting_events
             WHERE original_event_id = original.id AND event_kind = 'PROVIDER_FEE_REFUND';
            IF refunded + NEW.amount_minor > original.amount_minor THEN
              RAISE EXCEPTION 'fee refunds of withdrawal % would exceed the fee charged (% + % > %)', NEW.withdrawal_id,
                refunded, NEW.amount_minor, original.amount_minor USING ERRCODE = 'check_violation';
            END IF;
          END IF;
        END IF;

        IF posting.type <> 'SETTLEMENT' OR posting.user_id IS NOT NULL
           OR (SELECT count(*) FROM ledger_entries WHERE transaction_id = posting.id) <> 2
           OR NOT EXISTS (
             SELECT 1 FROM ledger_entries JOIN accounts ON accounts.id = ledger_entries.account_id
              WHERE ledger_entries.transaction_id = posting.id AND ledger_entries.direction = 'DEBIT'
                AND accounts.code = debit_code || ':' || withdrawal.currency_code AND accounts.bucket = withdrawal.internal_bucket
                AND ledger_entries.amount_minor = NEW.amount_minor)
           OR NOT EXISTS (
             SELECT 1 FROM ledger_entries JOIN accounts ON accounts.id = ledger_entries.account_id
              WHERE ledger_entries.transaction_id = posting.id AND ledger_entries.direction = 'CREDIT'
                AND accounts.code = credit_code || ':' || withdrawal.currency_code AND accounts.bucket = withdrawal.internal_bucket
                AND ledger_entries.amount_minor = NEW.amount_minor) THEN
          RAISE EXCEPTION 'a % of withdrawal % must be DR % / CR % in its bucket, internal and exact', NEW.event_kind,
            NEW.withdrawal_id, debit_code, credit_code USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER withdrawal_accounting_events_check_insert BEFORE INSERT ON withdrawal_accounting_events
        FOR EACH ROW EXECUTE FUNCTION withdrawal_accounting_events_check_insert()
    `);

    await queryRunner.query(`
      CREATE FUNCTION withdrawal_review_events_check_insert() RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM flow_instances WHERE id = NEW.flow_id
                          AND flow_type IN ('PAYSTACK_WITHDRAWAL', 'PAYSTACK_BENEFICIARY')) THEN
          RAISE EXCEPTION 'review events belong to withdrawal or beneficiary flows' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.previous_event_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM withdrawal_review_events WHERE id = NEW.previous_event_id AND flow_id = NEW.flow_id) THEN
          RAISE EXCEPTION 'a review event continues its own flow''s review' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER withdrawal_review_events_check_insert BEFORE INSERT ON withdrawal_review_events
        FOR EACH ROW EXECUTE FUNCTION withdrawal_review_events_check_insert()
    `);
  }

  private async createMutationGuards(queryRunner: QueryRunner): Promise<void> {
    for (const table of APPEND_ONLY_TABLES) {
      await queryRunner.query(`
        CREATE TRIGGER ${table}_refuse_mutation BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION withdrawal_evidence_refuse_mutation()
      `);
      await queryRunner.query(`
        CREATE TRIGGER ${table}_refuse_truncate BEFORE TRUNCATE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION withdrawal_evidence_refuse_mutation()
      `);
      await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM fx_app`);
    }
    await queryRunner.query(`REVOKE INSERT ON stash_receipts FROM fx_app`);

    for (const [table, key, mutable] of [
      ['withdrawal_beneficiaries', 'id', BENEFICIARY_MUTABLE],
      ['paystack_withdrawals', 'flow_id', WITHDRAWAL_MUTABLE],
    ] as const) {
      await queryRunner.query(`
        CREATE FUNCTION ${table}_guard_mutation() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION '${table} rows are never deleted (attempted DELETE on %)', OLD.${key}
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF (to_jsonb(NEW)${without([...mutable, 'current_review_event_id'])})
             IS DISTINCT FROM (to_jsonb(OLD)${without([...mutable, 'current_review_event_id'])}) THEN
            RAISE EXCEPTION '${table} % is immutable apart from its progression', OLD.${key}
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF ${setOnceViolation(mutable)} THEN
            RAISE EXCEPTION '${table} % has already recorded that fact; it is set once', OLD.${key}
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF NEW.current_review_event_id IS DISTINCT FROM OLD.current_review_event_id AND NEW.current_review_event_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM withdrawal_review_events
                              WHERE id = NEW.current_review_event_id AND flow_id = NEW.flow_id) THEN
            RAISE EXCEPTION '${table} % can only point at its own flow''s review', OLD.${key}
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql
      `);
      await queryRunner.query(`
        CREATE TRIGGER ${table}_guard_mutation BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION ${table}_guard_mutation()
      `);
      await queryRunner.query(`
        CREATE TRIGGER ${table}_refuse_truncate BEFORE TRUNCATE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION withdrawal_evidence_refuse_mutation()
      `);
      await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM fx_app`);
      await queryRunner.query(`GRANT UPDATE (${[...mutable, 'current_review_event_id'].join(', ')}) ON ${table} TO fx_app`);
    }
  }

  /** The per-state facts, checked when the transaction commits (so a multi-statement unit may build them in order). */
  private async createConsistencyChecks(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION assert_withdrawal_consistent(p_flow_id UUID) RETURNS VOID AS $$
      DECLARE
        flow           flow_instances%ROWTYPE;
        withdrawal     paystack_withdrawals%ROWTYPE;
        reservation    reservations%ROWTYPE;
        confirmations  INTEGER;
        reversals      INTEGER;
        problem        TEXT;
      BEGIN
        SELECT * INTO flow FROM flow_instances WHERE id = p_flow_id;
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = p_flow_id;
        IF withdrawal.flow_id IS NULL THEN
          problem := 'has no withdrawal';
        ELSIF NOT EXISTS (SELECT 1 FROM withdrawal_destinations WHERE withdrawal_id = p_flow_id) THEN
          problem := 'has no frozen destination';
        ELSE
          SELECT * INTO reservation FROM reservations WHERE id = withdrawal.reservation_id;
          SELECT count(*) FILTER (WHERE event_kind = 'CONFIRMATION'), count(*) FILTER (WHERE event_kind = 'REVERSAL')
            INTO confirmations, reversals FROM stash_receipts WHERE withdrawal_id = p_flow_id;

          IF reservation.id IS NULL THEN
            problem := 'has no reservation';
          ELSIF (reservation.flow_id, reservation.account_id, reservation.amount_minor, reservation.expiry_policy)
                IS DISTINCT FROM (p_flow_id, withdrawal.account_id, withdrawal.total_debit_minor, 'FLOW_CONTROLLED'::reservation_expiry_policy) THEN
            problem := 'holds a reservation that is not its protected hold of the total debit';
          ELSIF flow.state IN ('RESERVED', 'SUBMITTING', 'PROCESSING') THEN
            IF reservation.status <> 'ACTIVE' THEN
              problem := 'is unresolved but its hold is ' || reservation.status;
            ELSIF (flow.state = 'RESERVED') <> (withdrawal.submission_started_at IS NULL) THEN
              problem := 'disagrees with its submission marker';
            ELSIF num_nonnulls(withdrawal.posted_at, withdrawal.failed_at, withdrawal.reversed_at) > 0 OR confirmations + reversals > 0 THEN
              problem := 'is unresolved but records an outcome';
            END IF;
          ELSIF flow.state IN ('POSTED', 'REVERSED') THEN
            IF reservation.status <> 'SETTLED' OR reservation.settlement_transaction_id IS DISTINCT FROM withdrawal.principal_transaction_id
               OR reservation.settled_minor IS DISTINCT FROM withdrawal.total_debit_minor THEN
              problem := 'is posted but its hold was not settled by exactly its principal posting';
            ELSIF withdrawal.posted_at IS NULL OR confirmations <> 1 THEN
              problem := 'is posted without exactly one confirmation';
            ELSIF (flow.state = 'REVERSED') <> (withdrawal.reversed_at IS NOT NULL) OR (flow.state = 'REVERSED') <> (reversals = 1)
                  OR reversals > 1 THEN
              problem := 'disagrees with its reversal facts';
            END IF;
          ELSIF flow.state = 'FAILED' THEN
            IF reservation.status <> 'RELEASED' THEN
              problem := 'failed but its hold is ' || reservation.status;
            ELSIF withdrawal.failed_at IS NULL OR withdrawal.posted_at IS NOT NULL OR confirmations + reversals > 0 THEN
              problem := 'failed but records a completion';
            ELSIF withdrawal.submission_started_at IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = p_flow_id AND outcome = 'DEFINITIVE_FAILURE') THEN
              problem := 'failed after sending without a definitive-failure certificate';
            END IF;
          ELSE
            problem := 'is in unknown state ' || flow.state;
          END IF;
        END IF;

        IF problem IS NOT NULL THEN
          RAISE EXCEPTION 'withdrawal flow % (%) %', p_flow_id, flow.state, problem USING ERRCODE = 'check_violation';
        END IF;
      END $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE FUNCTION assert_beneficiary_consistent(p_flow_id UUID) RETURNS VOID AS $$
      DECLARE
        flow        flow_instances%ROWTYPE;
        beneficiary withdrawal_beneficiaries%ROWTYPE;
        problem     TEXT;
      BEGIN
        SELECT * INTO flow FROM flow_instances WHERE id = p_flow_id;
        SELECT * INTO beneficiary FROM withdrawal_beneficiaries WHERE flow_id = p_flow_id;
        IF beneficiary.id IS NULL THEN
          problem := 'has no beneficiary';
        ELSIF (flow.state = 'FAILED') <> (beneficiary.failure_code IS NOT NULL) THEN
          problem := 'disagrees with its failure code';
        ELSIF flow.state = 'REQUESTED' AND beneficiary.resolved_at IS NOT NULL THEN
          problem := 'is resolved but still REQUESTED';
        ELSIF flow.state IN ('RESOLVED', 'CREATING', 'READY') AND beneficiary.resolved_at IS NULL THEN
          problem := 'has no resolution';
        ELSIF flow.state = 'RESOLVED' AND beneficiary.recipient_bound_at IS NOT NULL THEN
          problem := 'has a recipient before CREATING';
        ELSIF flow.state = 'READY' AND beneficiary.recipient_bound_at IS NULL THEN
          problem := 'is READY without a validated recipient';
        END IF;
        IF problem IS NOT NULL THEN
          RAISE EXCEPTION 'beneficiary flow % (%) %', p_flow_id, flow.state, problem USING ERRCODE = 'check_violation';
        END IF;
      END $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE FUNCTION withdrawal_flows_check_consistency() RETURNS trigger AS $$
      BEGIN
        CASE TG_TABLE_NAME
          WHEN 'flow_instances' THEN
            IF NEW.flow_type = 'PAYSTACK_WITHDRAWAL' THEN PERFORM assert_withdrawal_consistent(NEW.id);
            ELSIF NEW.flow_type = 'PAYSTACK_BENEFICIARY' THEN PERFORM assert_beneficiary_consistent(NEW.id);
            END IF;
          WHEN 'withdrawal_beneficiaries' THEN PERFORM assert_beneficiary_consistent(NEW.flow_id);
          WHEN 'paystack_withdrawals' THEN PERFORM assert_withdrawal_consistent(NEW.flow_id);
          WHEN 'reservations' THEN PERFORM assert_withdrawal_consistent(NEW.flow_id);
          ELSE PERFORM assert_withdrawal_consistent(NEW.withdrawal_id);
        END CASE;
        RETURN NULL;
      END $$ LANGUAGE plpgsql
    `);
    for (const [table, events, when] of [
      ['flow_instances', 'INSERT OR UPDATE', `NEW.flow_type IN ('PAYSTACK_WITHDRAWAL', 'PAYSTACK_BENEFICIARY')`],
      ['withdrawal_beneficiaries', 'INSERT OR UPDATE', 'TRUE'],
      ['paystack_withdrawals', 'INSERT OR UPDATE', 'TRUE'],
      ['reservations', 'INSERT OR UPDATE', `NEW.expiry_policy = 'FLOW_CONTROLLED'`],
      ['withdrawal_destinations', 'INSERT', 'TRUE'],
      ['withdrawal_verifications', 'INSERT', 'TRUE'],
      ['stash_receipts', 'INSERT', 'TRUE'],
    ] as const) {
      await queryRunner.query(`
        CREATE CONSTRAINT TRIGGER ${table}_withdrawal_consistency AFTER ${events} ON ${table}
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (${when})
          EXECUTE FUNCTION withdrawal_flows_check_consistency()
      `);
    }
  }

  private async createReceiptFunction(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION record_stash_receipt(p_withdrawal_id UUID, p_verification_id UUID) RETURNS UUID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      DECLARE
        withdrawal    paystack_withdrawals%ROWTYPE;
        verification  withdrawal_verifications%ROWTYPE;
        kind          stash_receipt_kind;
        posting_id    UUID;
        reverses      UUID;
        existing      stash_receipts%ROWTYPE;
        receipt_id    UUID;
      BEGIN
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = p_withdrawal_id;
        SELECT * INTO verification FROM withdrawal_verifications WHERE id = p_verification_id AND withdrawal_id = p_withdrawal_id;
        IF withdrawal.flow_id IS NULL OR verification.id IS NULL THEN
          RAISE EXCEPTION 'no verification % of withdrawal %', p_verification_id, p_withdrawal_id USING ERRCODE = 'check_violation';
        END IF;
        CASE verification.outcome
          WHEN 'SUCCESS' THEN kind := 'CONFIRMATION'; posting_id := withdrawal.principal_transaction_id;
          WHEN 'FULL_RETURN' THEN kind := 'REVERSAL'; posting_id := withdrawal.reversal_transaction_id;
          ELSE RAISE EXCEPTION 'a % outcome changes no stash', verification.outcome USING ERRCODE = 'check_violation';
        END CASE;

        SELECT * INTO existing FROM stash_receipts WHERE withdrawal_id = p_withdrawal_id AND event_kind = kind;
        IF existing.id IS NOT NULL THEN
          IF existing.verification_id <> p_verification_id THEN
            RAISE EXCEPTION 'withdrawal % already has a % receipt from another verification', p_withdrawal_id, kind
              USING ERRCODE = 'check_violation';
          END IF;
          RETURN existing.id;
        END IF;
        IF kind = 'REVERSAL' THEN
          SELECT id INTO reverses FROM stash_receipts WHERE withdrawal_id = p_withdrawal_id AND event_kind = 'CONFIRMATION';
        END IF;

        INSERT INTO stash_receipts (stash_id, user_id, withdrawal_id, currency_code, amount_minor, event_kind, verification_id,
                                    ledger_transaction_id, value_time, value_time_basis, reverses_receipt_id)
        VALUES (withdrawal.stash_id, withdrawal.user_id, withdrawal.flow_id, withdrawal.currency_code, withdrawal.principal_minor,
                kind, verification.id, posting_id, verification.value_time, verification.value_time_basis, reverses)
        RETURNING id INTO receipt_id;
        RETURN receipt_id;
      END $$
    `);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION record_stash_receipt(UUID, UUID) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION record_stash_receipt(UUID, UUID) TO fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER flow_instances_withdrawal_consistency ON flow_instances`);
    await queryRunner.query(`DROP TRIGGER reservations_withdrawal_consistency ON reservations`);
    await queryRunner.query(`ALTER TABLE paystack_withdrawals DROP CONSTRAINT paystack_withdrawals_review_foreign_key`);
    await queryRunner.query(`ALTER TABLE withdrawal_beneficiaries DROP CONSTRAINT withdrawal_beneficiaries_review_foreign_key`);
    for (const table of [
      'withdrawal_review_events',
      'withdrawal_accounting_events',
      'stash_receipts',
    ]) {
      await queryRunner.query(`DROP TABLE ${table}`);
    }
    await queryRunner.query(`
      ALTER TABLE paystack_withdrawals
        DROP CONSTRAINT paystack_withdrawals_confirmation_foreign_key,
        DROP CONSTRAINT paystack_withdrawals_return_foreign_key
    `);
    for (const table of [
      'withdrawal_verifications',
      'paystack_transfer_observations',
      'withdrawal_destinations',
      'paystack_withdrawals',
      'customer_stashes',
      'withdrawal_beneficiaries',
    ]) {
      await queryRunner.query(`DROP TABLE ${table}`);
    }
    for (const fn of [
      'record_stash_receipt(UUID, UUID)',
      'withdrawal_flows_check_consistency()',
      'assert_beneficiary_consistent(UUID)',
      'assert_withdrawal_consistent(UUID)',
      'withdrawal_review_events_check_insert()',
      'withdrawal_accounting_events_check_insert()',
      'stash_receipts_check_insert()',
      'withdrawal_verifications_check_insert()',
      'paystack_transfer_observations_check_insert()',
      'withdrawal_destinations_check_insert()',
      'paystack_withdrawals_check_insert()',
      'withdrawal_beneficiaries_check_insert()',
      'paystack_withdrawals_guard_mutation()',
      'withdrawal_beneficiaries_guard_mutation()',
    ]) {
      await queryRunner.query(`DROP FUNCTION ${fn}`);
    }
    for (const type of [
      'withdrawal_review_owner',
      'withdrawal_review_reason',
      'withdrawal_review_event_kind',
      'withdrawal_evidence_basis',
      'withdrawal_accounting_event_kind',
      'stash_receipt_kind',
      'withdrawal_value_time_basis',
      'withdrawal_verification_outcome',
      'transfer_observation_source',
      'transfer_status_classification',
    ]) {
      await queryRunner.query(`DROP TYPE ${type}`);
    }
  }
}
