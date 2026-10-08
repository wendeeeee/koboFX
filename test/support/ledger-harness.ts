import { randomUUID } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import type { DestinationStream } from 'pino';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { API_PREFIX, PAYSTACK_WEBHOOK_PATH, PSP_WEBHOOK_PATH, configureApp } from '../../src/app.setup';
import { MockPaystack } from '../../src/mock-paystack/mock-paystack';
import { PaystackGateway } from '../../src/modules/payments/paystack/paystack-gateway.port';
import { CaptureCompletion, MockPsp } from '../../src/mock-psp/mock-psp';
import { MockExchangeRateApi, RECORDED_RATES } from '../../src/mock-exchange-rate-api/mock-exchange-rate-api';
import { FetchCoordination } from '../../src/modules/fx/fetch-coordination';
import { FxMetrics } from '../../src/modules/fx/fx-metrics';
import { FxPoller } from '../../src/modules/fx/fx-poller';
import { FxRateFetcher } from '../../src/modules/fx/fx-rate-fetcher';
import { FxRateService } from '../../src/modules/fx/fx-rate.service';
import { QuoteService } from '../../src/modules/fx/quote.service';
import { SNAPSHOT_CACHE_KEY } from '../../src/modules/fx/rate-cache';
import { AccountCreationService } from '../../src/modules/auth/account-creation.service';
import { VerificationService } from '../../src/modules/auth/verification.service';
import { FlowCheckpoints } from '../../src/modules/flows/flow-checkpoints';
import { FlowResumer } from '../../src/modules/flows/flow-resumer';
import { FlowRunner } from '../../src/modules/flows/flow-runner';
import { WebhookProcessor } from '../../src/modules/payments/webhooks/webhook-processor';
import { RedisService } from '../../src/redis/redis.service';
import { PaystackTransfersModule } from '../../src/modules/payments/paystack/transfers/paystack-transfers.module';
import { PaystackTransfersGateway } from '../../src/modules/payments/paystack/transfers/paystack-transfers.port';
import { WithdrawalWorkerHeartbeat } from '../../src/modules/withdrawals/withdrawal-admission-gate';
import { Clock } from '../../src/common/clock';
import { EmailSender } from '../../src/modules/notifications/email/email-sender';
import { OutboxDispatcher } from '../../src/modules/outbox/outbox-dispatcher';
import { Money } from '../../src/common/money';
import { ConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import { UnitOfWork } from '../../src/database/transaction/unit-of-work';
import { ChartOfAccountsService } from '../../src/modules/ledger/chart-of-accounts.service';
import { LedgerChecksService, LedgerIntegrityReport } from '../../src/modules/ledger/ledger-checks.service';
import { LedgerModule } from '../../src/modules/ledger/ledger.module';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import {
  ConversionProvenance,
  EntryDirection,
  PostedTransaction,
  PostingAuthorization,
  TransactionType,
} from '../../src/modules/ledger/ledger.types';
import { ReservationChecksService } from '../../src/modules/reservations/reservation-checks.service';
import { ReservationService } from '../../src/modules/reservations/reservation.service';
import { ReservationsModule } from '../../src/modules/reservations/reservations.module';
import { BreakService, ReconciliationBreak } from '../../src/modules/reconciliation/break.service';
import { ExternalReconciliationJob } from '../../src/modules/reconciliation/external-reconciliation.job';
import { InternalReconciliationJob } from '../../src/modules/reconciliation/internal-reconciliation.job';
import { ReconciliationCheckpoints } from '../../src/modules/reconciliation/reconciliation-checkpoints';
import { ReconciliationMetrics } from '../../src/modules/reconciliation/reconciliation-metrics';
import { ReconciliationRun, ReconciliationRunRepository } from '../../src/modules/reconciliation/reconciliation-run.repository';
import { ReconciliationRunKind } from '../../src/modules/reconciliation/reconciliation-schedule';
import { ReconciliationScheduler, RunResult } from '../../src/modules/reconciliation/reconciliation-scheduler';
import { SettlementIngestionService } from '../../src/modules/reconciliation/settlement-ingestion.service';
import { AdminMetrics } from '../../src/modules/admin/admin-metrics';
import { ApprovalRepository } from '../../src/modules/admin/approvals/approval.repository';
import { ApprovalService } from '../../src/modules/admin/approvals/approval.service';
import { AdminMonitor } from '../../src/modules/admin/break-glass/admin-monitor';
import { CapturingEmailSender, TestClock } from './auth-test-doubles';
import { paymentProviderTestSecrets } from './authentication-secrets';
import { ScriptedFlowCheckpoints } from './flow-test-doubles';
import { ScriptedReconciliationCheckpoints } from './reconciliation-test-doubles';
import { TestDatabase, startTestDatabase } from './test-database';

export const PLACEHOLDER_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$aGFybmVzcw$aGFybmVzcw';

export interface UserAccount {
  readonly userId: string;
  readonly walletId: string;
  readonly accountId: string;
  readonly currency: string;
}


export interface LedgerSnapshot {
  readonly transactionCount: number;
  readonly entryCount: number;
  readonly accountsDigest: string;
  readonly transactionsDigest: string;
  readonly reservationsDigest: string;
  readonly flowCount: number;
  readonly idempotencyKeyCount: number;
  readonly userCount: number;
  readonly walletCount: number;
  readonly outboxEventCount: number;
  readonly auditLogCount: number;
}


export interface AuthHarness {
  readonly app: NestExpressApplication;
  readonly redis: StartedRedisContainer;
  readonly emails: CapturingEmailSender;
  readonly clock: TestClock;
  readonly outbox: OutboxDispatcher;
  deliverOutbox(): Promise<void>;
}

export interface HarnessOptions {
  readonly auth?: boolean;
  readonly logStream?: DestinationStream;
 
  readonly payments?: { readonly captureCompletion?: CaptureCompletion; readonly hangMilliseconds?: number } | true;

  readonly fx?: { readonly open?: boolean } | true;

  readonly paystack?:
    | {
        readonly hangMilliseconds?: number;
        readonly checkoutWindowMinutes?: number;
        readonly webhookIpAllowlist?: string;
        /** Also import `PaystackTransfersModule` (W2: the transfers gateway + the TRANSFER webhook family). */
        readonly transfers?: boolean;
        /** W3: admit withdrawals (switch on, NGN limits, the account identity) and expose `paystack.withdrawals`. */
        readonly withdrawals?: boolean | { readonly limits?: string };
      }
    | true;
}

export interface PaystackHarness {
  readonly mock: MockPaystack;
  readonly secretKey: string;
  fund(user: SignedUpUser, body: Record<string, unknown>, idempotencyKey?: string): request.Test;
  status(user: SignedUpUser, fundingId: string): request.Test;
  postWebhook(body: Buffer, headers: Record<string, string>): request.Test;
 
  readonly gatewayCalls: { readonly operation: string; readonly insideTransaction: boolean }[];
  /** W3 (with `paystack: { withdrawals: true }`): the customer routes and the worker heartbeat. */
  readonly withdrawals: WithdrawalsHarness | undefined;
}

export interface WithdrawalsHarness {
  addBeneficiary(user: SignedUpUser, body: Record<string, unknown>, idempotencyKey?: string): request.Test;
  beneficiary(user: SignedUpUser, beneficiaryId: string): request.Test;
  beneficiaries(user: SignedUpUser, query?: Record<string, string>): request.Test;
  /**
   * POST /wallet/withdraw/paystack. Without `oneTimePassword` in the body it first gets a REAL code: requests one
   * (clearing the code-request limits), plays the worker, reads it from the captured email. The code is remembered per
   * Idempotency-Key, so a same-key retry sends the identical body. Pass `oneTimePassword` to send your own.
   */
  withdraw(user: SignedUpUser, body: Record<string, unknown>, idempotencyKey?: string): Promise<request.Response>;
  /** POST /wallet/withdraw/one-time-password (as is: limits apply). */
  requestCode(user: SignedUpUser): request.Test;
  /** Request a code, play the worker, return the emailed code (null if the request was refused). */
  freshCode(user: SignedUpUser): Promise<string | null>;
  withdrawal(user: SignedUpUser, withdrawalId: string): request.Test;
  banks(user: SignedUpUser, query?: Record<string, string>): request.Test;
  /** Play the worker's heartbeat (admission needs a fresh one). */
  beat(): Promise<void>;
  /** Every transfers-gateway call, and whether a database transaction was open (it must never be). */
  readonly gatewayCalls: { readonly operation: string; readonly insideTransaction: boolean }[];
}

export interface FxHarness {
  readonly api: MockExchangeRateApi;
  readonly apiKey: string;
  readonly fetcher: FxRateFetcher;
  readonly poller: FxPoller;
  readonly rates: FxRateService;
  readonly quotes: QuoteService;
  readonly coordination: FetchCoordination;
  readonly metrics: FxMetrics;
  publishFresh(rates?: Record<string, string>, options?: { publishedSecondsAgo?: number; nextUpdateInSeconds?: number }): void;
  warm(rates?: Record<string, string>): Promise<void>;
  resetRedisState(): Promise<void>;
  flushSnapshotCache(): Promise<void>;
  providerCallCount(): Promise<number>;
  quote(user: SignedUpUser, body: Record<string, unknown>, idempotencyKey?: string): request.Test;
}

export const HARNESS_USER_PASSWORD = 'correct horse battery staple';

export interface SignedUpUser {
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
}


export interface ReconciliationHarness {
  readonly scheduler: ReconciliationScheduler;
  readonly internal: InternalReconciliationJob;
  readonly external: ExternalReconciliationJob;
  readonly ingestion: SettlementIngestionService;
  readonly breaks: BreakService;
  readonly runs: ReconciliationRunRepository;
  readonly metrics: ReconciliationMetrics;
  readonly checkpoints: ScriptedReconciliationCheckpoints;
  run(kind: ReconciliationRunKind, periodKey?: string): Promise<RunResult>;
  allBreaks(): Promise<ReconciliationBreak[]>;
  liveBreaks(): Promise<ReconciliationBreak[]>;
  runRow(kind: ReconciliationRunKind, periodKey: string): Promise<ReconciliationRun | null>;
}

export interface Administrators {
  readonly admin: SignedUpUser;
  readonly security: SignedUpUser;
}


export interface AdminHarness {
  readonly approvals: ApprovalService;
  readonly repository: ApprovalRepository;
  readonly metrics: AdminMetrics;
  readonly monitor: AdminMonitor;
  bootstrap(): Promise<Administrators>;
  grant(role: 'ADMIN' | 'SECURITY', requester: SignedUpUser, approver: SignedUpUser): Promise<SignedUpUser>;
  request(user: SignedUpUser, body: Record<string, unknown>, idempotencyKey?: string): request.Test;
  decide(user: SignedUpUser, approvalId: string, decision: 'approve' | 'reject' | 'cancel' | 'review', body?: Record<string, unknown>, idempotencyKey?: string): request.Test;
  get(user: SignedUpUser, path: string): request.Test;
  requestAndApprove(requester: SignedUpUser, approver: SignedUpUser, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface PaymentsHarness {
  readonly psp: MockPsp;
  readonly runner: FlowRunner;
  readonly resumer: FlowResumer;
  readonly processor: WebhookProcessor;
  readonly checkpoints: ScriptedFlowCheckpoints;
  signUp(): Promise<SignedUpUser>;
  fund(user: SignedUpUser, body: Record<string, unknown>, idempotencyKey?: string): request.Test;
  logIn(user: SignedUpUser): Promise<SignedUpUser>;
  clearRateLimits(rule?: string): Promise<void>;
  makeAllDue(): Promise<void>;
  lapseLeases(): Promise<void>;
  
  drive(options?: { rounds?: number; deliverWebhooks?: boolean }): Promise<void>;
  readonly reconciliation: ReconciliationHarness;
  readonly admin: AdminHarness;
  readonly paystack: PaystackHarness | undefined;
}

export interface LedgerHarness {
  readonly db: TestDatabase;
  readonly moduleRef: TestingModule;
  readonly dataSource: DataSource;
  readonly unitOfWork: UnitOfWork;
  readonly ledger: LedgerService;
  readonly chartOfAccounts: ChartOfAccountsService;
  readonly checks: LedgerChecksService;
  readonly reservations: ReservationService;
  readonly reservationChecks: ReservationChecksService;
  readonly auth: AuthHarness | undefined;
  readonly payments: PaymentsHarness | undefined;
  readonly fx: FxHarness | undefined;
  createWallet(): Promise<{ userId: string; walletId: string }>;
 
  newFlowIds(count: number): Promise<string[]>;
  openUserAccount(currency: string, wallet?: { userId: string; walletId: string }): Promise<UserAccount>;
  fund(account: UserAccount, amountMinor: bigint): Promise<PostedTransaction>;
  balanceOf(accountId: string): Promise<bigint>;
 
  conversionProvenance(input: {
    sourceCurrency: string;
    sourceAmountMinor: bigint;
    targetCurrency: string;
    targetAmountMinor: bigint;
  }): Promise<ConversionProvenance>;
  reservedOf(accountId: string): Promise<bigint>;
  snapshot(): Promise<LedgerSnapshot>;

  expectCleanBooks(): Promise<LedgerIntegrityReport>;
  close(): Promise<void>;
}

export async function startLedgerHarness(
  overrides: Record<string, string> = {},
  options: HarnessOptions = {},
): Promise<LedgerHarness> {
  const withFx = options.fx !== undefined;
  const withPaystack = options.paystack !== undefined;
  const withPayments = options.payments !== undefined || withFx || withPaystack;
  const paystackOptions = options.paystack === true ? {} : (options.paystack ?? {});
  const paystackSecretKey = `sk_test_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const fxOpen = typeof options.fx === 'object' && options.fx.open === true;
  const fxApiKey = `mockfxkey${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const fxApi = withFx ? new MockExchangeRateApi({ apiKey: fxApiKey }) : undefined;
  const fxUrl = fxApi ? await fxApi.start() : undefined;
  const redis = options.auth || withPayments ? await new RedisContainer('redis:7-alpine').start() : undefined;
  const pspSecrets = paymentProviderTestSecrets();
  const pspOptions = options.payments === true ? {} : (options.payments ?? {});
  const clock = new TestClock();
  const psp = withPayments
    ? new MockPsp({
        secretKey: pspSecrets.secretKey,
        webhookSecret: pspSecrets.webhookSecret,
        captureCompletion: pspOptions.captureCompletion ?? 'immediate',
        hangMilliseconds: pspOptions.hangMilliseconds ?? 600,
        now: () => clock.now(),
      })
    : undefined;
  const pspUrl = psp ? await psp.start() : undefined;
  const paystackMock = withPaystack
    ? new MockPaystack({ secretKey: paystackSecretKey, now: () => clock.now(), hangMilliseconds: paystackOptions.hangMilliseconds ?? 1300 })
    : undefined;
  const paystackUrl = paystackMock ? await paystackMock.start() : undefined;
  const db = await startTestDatabase({
    ...(redis ? { REDIS_URL: redis.getConnectionUrl() } : {}),
    ...(pspUrl
      ? {
          PSP_BASE_URL: pspUrl,
          PSP_REQUEST_TIMEOUT_MILLISECONDS: '300',
          FUNDING_LIMITS: '{"NGN":{"minimum":"100","maximum":"100000000000"},"USD":{"minimum":"100","maximum":"10000000"}}',
          PSP_FUNDING_CURRENCIES: 'NGN,USD',
          SETTLEMENT_WINDOWS: '{"NGN":{"businessDays":2,"graceHours":24},"USD":{"businessDays":2,"graceHours":24}}',
        }
      : {}),
    ...(paystackUrl
      ? {
          PAYSTACK_ENABLED: 'true',
          PAYSTACK_SECRET_KEY: paystackSecretKey,
          PAYSTACK_BASE_URL: paystackUrl,
          PAYSTACK_CALLBACK_URL: 'http://localhost:5173/funding/return',
          PAYSTACK_FUNDING_CURRENCIES: 'NGN,USD',
          PAYSTACK_REQUEST_TIMEOUT_MILLISECONDS: '300',
          PAYSTACK_INITIALIZE_TIMEOUT_MILLISECONDS: '1000',
          ...(paystackOptions.checkoutWindowMinutes ? { PAYSTACK_CHECKOUT_WINDOW_MINUTES: String(paystackOptions.checkoutWindowMinutes) } : {}),
          ...(paystackOptions.webhookIpAllowlist ? { PAYSTACK_WEBHOOK_IP_ALLOWLIST: paystackOptions.webhookIpAllowlist } : {}),
          ...(paystackOptions.withdrawals
            ? {
                PAYSTACK_WITHDRAWALS_ENABLED: 'true',
                PAYSTACK_ACCOUNT_IDENTITY: 'test-integration-1',
                PAYSTACK_WITHDRAWAL_LIMITS:
                  (typeof paystackOptions.withdrawals === 'object' ? paystackOptions.withdrawals.limits : undefined) ??
                  '{"NGN":{"minimum":"10000","maximum":"100000000","dailyMaximum":"500000000"}}',
              }
            : {}),
        }
      : { PAYSTACK_BASE_URL: 'http://127.0.0.1:9' }),
    ...(fxUrl
      ? {
          ...(fxOpen
            ? { FX_RATE_BASE_URL: `${fxUrl}/v6/latest`, FX_PROVIDER_PLAN: 'OPEN' }
            : { FX_RATE_BASE_URL: `${fxUrl}/v6/{apiKey}/latest`, FX_PROVIDER_PLAN: 'BUSINESS', EXCHANGE_RATE_API_KEY: fxApiKey }),
          FX_REQUEST_TIMEOUT_MILLISECONDS: '400',
          FX_LOCAL_CACHE_MILLISECONDS: '0',
        }
      : {}),
    ...overrides,
  });
  let moduleRef: TestingModule;
  let fx: FxHarness | undefined;
  let auth: AuthHarness | undefined;
  let payments: PaymentsHarness | undefined;
  const checkpoints = new ScriptedFlowCheckpoints();
  const reconciliationCheckpoints = new ScriptedReconciliationCheckpoints();
  if (redis) {
    const emails = new CapturingEmailSender();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(db.env, { logStream: options.logStream }), ...(paystackOptions.transfers ? [PaystackTransfersModule] : [])],
    })
      .overrideProvider(EmailSender)
      .useValue(emails)
      .overrideProvider(Clock)
      .useValue(clock)
      .overrideProvider(FlowCheckpoints)
      .useValue(checkpoints)
      .overrideProvider(ReconciliationCheckpoints)
      .useValue(reconciliationCheckpoints)
      .compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    const outbox = moduleRef.get(OutboxDispatcher);
    auth = {
      app,
      redis,
      emails,
      clock,
      outbox,
      async deliverOutbox() {
        while ((await outbox.dispatchDue(100)).claimed > 0) {
        }
      },
    };
    if (psp) {
      const http = () => request(app.getHttpServer());
      psp.setDeliverer(async (body, headers) => (await http().post(PSP_WEBHOOK_PATH).set(headers).send(body.toString('utf8'))).status);
      paystackMock?.setDeliverer(async (body, headers) => (await http().post(PAYSTACK_WEBHOOK_PATH).set(headers).send(body.toString('utf8'))).status);
      const runner = moduleRef.get(FlowRunner);
      const resumer = moduleRef.get(FlowResumer);
      const processor = moduleRef.get(WebhookProcessor);
      const appDataSource = moduleRef.get(DataSource);
      const authHarness = auth;
      const makeAllDue = async () => {
        await appDataSource.query(
          `UPDATE flow_instances SET next_attempt_at = now() WHERE completed_at IS NULL AND next_attempt_at > now()`,
        );
        await appDataSource.query(
          `UPDATE webhook_events SET next_attempt_at = now() WHERE processed_at IS NULL AND next_attempt_at > now()`,
        );
      };
      let signUpQueue: Promise<unknown> = Promise.resolve();
      const signUpOne = async (): Promise<SignedUpUser> => {
        const email = `funding-${randomUUID().slice(0, 12)}@example.com`;
        const password = HARNESS_USER_PASSWORD;
        await moduleRef.get(AccountCreationService).register(email, password);
        await authHarness.deliverOutbox();
        const session = await moduleRef
          .get(VerificationService)
          .verifyEmail(email, password, authHarness.emails.latestCodeFor(email));
        return { userId: session.user.id, email, accessToken: session.tokens.access.token };
      };
      const scheduler = moduleRef.get(ReconciliationScheduler);
      const breaks = moduleRef.get(BreakService);
      const runs = moduleRef.get(ReconciliationRunRepository);
      let periodSequence = 0;
      const reconciliation: ReconciliationHarness = {
        scheduler,
        internal: moduleRef.get(InternalReconciliationJob),
        external: moduleRef.get(ExternalReconciliationJob),
        ingestion: moduleRef.get(SettlementIngestionService),
        breaks,
        runs,
        metrics: moduleRef.get(ReconciliationMetrics),
        checkpoints: reconciliationCheckpoints,
        async run(kind, periodKey) {
          periodSequence += 1;
          const key = periodKey ?? `${String(3000 + periodSequence).padStart(4, '0')}-01-01`;
          const result = await scheduler.runPeriod(kind, key);
          if (!result) throw new Error(`Run ${kind} ${key} was not claimed`);
          return result;
        },
        async allBreaks() {
          const rows = (await appDataSource.query(`SELECT id FROM reconciliation_breaks ORDER BY first_detected_at, id`)) as { id: string }[];
          return Promise.all(rows.map(async (row) => (await breaks.findById(row.id))!));
        },
        liveBreaks: () => breaks.live(),
        runRow: (kind, periodKey) => runs.find(kind, periodKey),
      };
      const adminPath = (path: string) => `/${API_PREFIX}/admin/${path}`;
      const signUp = () => {
        const next = signUpQueue.then(signUpOne, signUpOne);
        signUpQueue = next.catch(() => undefined);
        return next;
      };
      const adminRequest = (user: SignedUpUser, body: Record<string, unknown>, idempotencyKey = randomUUID()) =>
        http().post(adminPath('approvals')).set('Authorization', `Bearer ${user.accessToken}`).set('Idempotency-Key', idempotencyKey).send(body);
      const decide: AdminHarness['decide'] = (user, approvalId, decision, body = {}, idempotencyKey = randomUUID()) =>
        http()
          .post(adminPath(`approvals/${approvalId}/${decision}`))
          .set('Authorization', `Bearer ${user.accessToken}`)
          .set('Idempotency-Key', idempotencyKey)
          .send(body);
      const requestAndApprove: AdminHarness['requestAndApprove'] = async (requester, approver, body) => {
        const requested = await adminRequest(requester, body);
        if (requested.status !== 201) throw new Error(`request: ${requested.status} ${JSON.stringify(requested.body)}`);
        const approved = await decide(approver, (requested.body as { approvalId: string }).approvalId, 'approve');
        if (approved.status !== 200) throw new Error(`approve: ${approved.status} ${JSON.stringify(approved.body)}`);
        return approved.body as Record<string, unknown>;
      };
      const admin: AdminHarness = {
        approvals: moduleRef.get(ApprovalService),
        repository: moduleRef.get(ApprovalRepository),
        metrics: moduleRef.get(AdminMetrics),
        monitor: moduleRef.get(AdminMonitor),
        async bootstrap() {
          const [first, second] = [await signUp(), await signUp()];
          const owner = await db.ownerClient();
          try {
            await owner.query(`SELECT bootstrap_first_administrators($1, $2)`, [first.userId, second.userId]);
          } finally {
            await owner.end();
          }
          return { admin: first, security: second };
        },
        async grant(role, requester, approver) {
          const user = await signUp();
          const approval = await requestAndApprove(requester, approver, {
            actionType: 'ROLE_CHANGE',
            payload: { userId: user.userId, role, operation: 'GRANT' },
            reason: `grant ${role} (test)`,
          });
          if (approval.status !== 'EXECUTED') throw new Error(`grant(): ${JSON.stringify(approval)}`);
          return user;
        },
        request: adminRequest,
        decide,
        get: (user, path) => http().get(adminPath(path)).set('Authorization', `Bearer ${user.accessToken}`),
        requestAndApprove,
      };
      const gatewayCalls: { operation: string; insideTransaction: boolean }[] = [];
      if (paystackMock) {
        const gateway = moduleRef.get(PaystackGateway);
        const unitOfWork = moduleRef.get(UnitOfWork);
        for (const operation of ['initialize', 'verify', 'listTransactions', 'listDisputes'] as const) {
          const original = gateway[operation].bind(gateway) as (...parameters: unknown[]) => Promise<unknown>;
          (gateway as unknown as Record<string, unknown>)[operation] = (...parameters: unknown[]) => {
            gatewayCalls.push({ operation, insideTransaction: unitOfWork.inTransaction });
            return original(...parameters);
          };
        }
      }
      const transfersGatewayCalls: { operation: string; insideTransaction: boolean }[] = [];
      let withdrawals: WithdrawalsHarness | undefined;
      if (paystackMock && paystackOptions.withdrawals) {
        const transfers = moduleRef.get(PaystackTransfersGateway, { strict: false });
        const unitOfWork = moduleRef.get(UnitOfWork);
        for (const operation of ['listBanks', 'resolveAccount', 'createRecipient', 'listRecipients', 'fetchRecipient', 'initiateTransfer', 'verifyTransfer', 'fetchTransfer', 'listTransfers', 'balances', 'balanceLedger'] as const) {
          const original = transfers[operation].bind(transfers) as (...parameters: unknown[]) => Promise<unknown>;
          (transfers as unknown as Record<string, unknown>)[operation] = (...parameters: unknown[]) => {
            transfersGatewayCalls.push({ operation, insideTransaction: unitOfWork.inTransaction });
            return original(...parameters);
          };
        }
        const heartbeat = moduleRef.get(WithdrawalWorkerHeartbeat, { strict: false });
        const authorized = (test: request.Test, user: SignedUpUser) => test.set('Authorization', `Bearer ${user.accessToken}`);
        const codesByKey = new Map<string, string>();
        const requestCode = (user: SignedUpUser) => authorized(http().post(`/${API_PREFIX}/wallet/withdraw/one-time-password`), user).send();
        // Serialised: the outbox drain and the captured mailbox are shared by parallel callers.
        let codeQueue: Promise<unknown> = Promise.resolve();
        const freshCode = (user: SignedUpUser): Promise<string | null> => {
          const next = codeQueue.then(async () => {
            await moduleRef
              .get(RedisService)
              .evaluate(`for _, key in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', key) end return 0`, [], ['rate-limit:withdrawal-code-*']);
            const response = await requestCode(user);
            if (response.status !== 202) return null;
            await auth!.deliverOutbox();
            return auth!.emails.latestWithdrawalCodeFor(user.email);
          });
          codeQueue = next.catch(() => undefined);
          return next;
        };
        withdrawals = {
          gatewayCalls: transfersGatewayCalls,
          addBeneficiary: (user, body, idempotencyKey = randomUUID()) =>
            authorized(http().post(`/${API_PREFIX}/wallet/withdrawal-beneficiaries`), user).set('Idempotency-Key', idempotencyKey).send(body),
          beneficiary: (user, beneficiaryId) => authorized(http().get(`/${API_PREFIX}/wallet/withdrawal-beneficiaries/${beneficiaryId}`), user),
          beneficiaries: (user, query = {}) => authorized(http().get(`/${API_PREFIX}/wallet/withdrawal-beneficiaries`).query(query), user),
          withdraw: async (user, body, idempotencyKey = randomUUID()) => {
            let sent = body;
            if (!('oneTimePassword' in body)) {
              let code = codesByKey.get(idempotencyKey);
              if (code === undefined) {
                const fresh = await freshCode(user);
                if (fresh !== null) codesByKey.set(idempotencyKey, fresh);
                code = fresh ?? '000000'; // the code request was refused (e.g. disabled): the withdraw shows why; not remembered
              }
              sent = { ...body, oneTimePassword: code };
            }
            return authorized(http().post(`/${API_PREFIX}/wallet/withdraw/paystack`), user).set('Idempotency-Key', idempotencyKey).send(sent);
          },
          requestCode: (user) => requestCode(user),
          freshCode: (user) => freshCode(user),
          withdrawal: (user, withdrawalId) => authorized(http().get(`/${API_PREFIX}/wallet/withdraw/${withdrawalId}`), user),
          banks: (user, query = {}) => authorized(http().get(`/${API_PREFIX}/wallet/withdrawal-banks`).query(query), user),
          beat: () => heartbeat.beat(),
        };
        await heartbeat.beat();
      }
      const paystack: PaystackHarness | undefined = paystackMock
        ? {
            withdrawals,
            gatewayCalls,
            mock: paystackMock,
            secretKey: paystackSecretKey,
            fund: (user, body, idempotencyKey = randomUUID()) =>
              http()
                .post(`/${API_PREFIX}/wallet/fund/paystack`)
                .set('Authorization', `Bearer ${user.accessToken}`)
                .set('Idempotency-Key', idempotencyKey)
                .send(body),
            status: (user, fundingId) => http().get(`/${API_PREFIX}/wallet/fund/${fundingId}`).set('Authorization', `Bearer ${user.accessToken}`),
            postWebhook: (body, headers) => http().post(PAYSTACK_WEBHOOK_PATH).set(headers).send(body.toString('utf8')),
          }
        : undefined;
      payments = {
        reconciliation,
        admin,
        paystack,
        psp,
        runner,
        resumer,
        processor,
        checkpoints,
        signUp,
        fund(user, body, idempotencyKey = randomUUID()) {
          return http()
            .post(`/${API_PREFIX}/wallet/fund`)
            .set('Authorization', `Bearer ${user.accessToken}`)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);
        },
        makeAllDue,
        async logIn(user) {
          const response = await http().post(`/${API_PREFIX}/auth/login`).send({ email: user.email, password: HARNESS_USER_PASSWORD });
          if (response.status !== 200) throw new Error(`logIn(): ${response.status} ${JSON.stringify(response.body)}`);
          return { ...user, accessToken: (response.body as { tokens: { access: { token: string } } }).tokens.access.token };
        },
        async clearRateLimits(rule?: string) {
          const pattern = rule === undefined ? 'rate-limit:*' : `rate-limit:${rule}:*`;
          await moduleRef
            .get(RedisService)
            .evaluate(`for _, key in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', key) end return 0`, [], [pattern]);
        },
        async lapseLeases() {
          await appDataSource.query(
            `UPDATE flow_instances SET leased_until = now() - interval '1 second' WHERE lease_token IS NOT NULL`,
          );
        },
        async drive({ rounds = 12, deliverWebhooks = true } = {}) {
          for (let round = 0; round < rounds; round += 1) {
            // Make scheduled retries eligible before deciding there is no work left.
            await makeAllDue();
            let activity = 0;
            if (deliverWebhooks) activity += (await psp.deliverAll()).length + (paystackMock ? (await paystackMock.deliverAll()).length : 0);
            activity += (await processor.processDue(100)).claimed;
            activity += await resumer.resumeDue(100);
            if (activity === 0) return;
          }
        },
      };
    }
    if (fxApi) {
      auth.clock.freeze();
      const redisService = moduleRef.get(RedisService);
      const rates = moduleRef.get(FxRateService);
      const fetcher = moduleRef.get(FxRateFetcher);
      const clock = auth.clock;
      const appDataSource = moduleRef.get(DataSource);
      const app = auth.app;
      const http = () => request(app.getHttpServer());
      const publishFresh: FxHarness['publishFresh'] = (published = RECORDED_RATES, { publishedSecondsAgo = 60, nextUpdateInSeconds = 300 } = {}) => {
        const now = clock.now().getTime();
        fxApi.publish({ rates: published, publishedAt: new Date(now - publishedSecondsAgo * 1000), nextUpdateAt: new Date(now + nextUpdateInSeconds * 1000) });
      };
      fx = {
        api: fxApi,
        apiKey: fxApiKey,
        fetcher,
        poller: moduleRef.get(FxPoller),
        rates,
        quotes: moduleRef.get(QuoteService),
        coordination: moduleRef.get(FetchCoordination),
        metrics: moduleRef.get(FxMetrics),
        publishFresh,
        async warm(published) {
          publishFresh(published);
          const outcome = await fetcher.fetch('POLL');
          if (outcome.kind !== 'ACCEPTED') throw new Error(`warm(): expected ACCEPTED, got ${JSON.stringify(outcome)}`);
          rates.forgetLocalCopy();
        },
        async resetRedisState() {
          await redisService.evaluate(`for _, key in ipairs(redis.call('KEYS', 'fx:*')) do redis.call('DEL', key) end return 0`, [], []);
          rates.forgetLocalCopy();
        },
        async flushSnapshotCache() {
          await redisService.evaluate(`return redis.call('DEL', KEYS[1])`, [SNAPSHOT_CACHE_KEY], []);
          rates.forgetLocalCopy();
        },
        async providerCallCount() {
          const [row] = (await appDataSource.query(
            `SELECT count(*)::int AS count FROM provider_calls WHERE provider = 'exchange-rate-api'`,
          )) as { count: number }[];
          return row.count;
        },
        quote(user, body, idempotencyKey = randomUUID()) {
          return http()
            .post(`/${API_PREFIX}/fx/quotes`)
            .set('Authorization', `Bearer ${user.accessToken}`)
            .set('Idempotency-Key', idempotencyKey)
            .send(body);
        },
      };
    }
  } else {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(db.env), DatabaseModule, LedgerModule, ReservationsModule],
    }).compile();
    await moduleRef.init();
  }

  const dataSource = moduleRef.get(DataSource);
  const ledger = moduleRef.get(LedgerService);
  const chartOfAccounts = moduleRef.get(ChartOfAccountsService);
  const checks = moduleRef.get(LedgerChecksService);
  const reservationChecks = moduleRef.get(ReservationChecksService);

  const createWallet = async () => {
    const [user] = (await dataSource.query(
      `INSERT INTO users (email, password_hash)
       VALUES ('ledger-' || gen_random_uuid() || '@example.com', $1) RETURNING id`,
      [PLACEHOLDER_PASSWORD_HASH],
    )) as { id: string }[];
    const [wallet] = (await dataSource.query(`INSERT INTO wallets (user_id) VALUES ($1) RETURNING id`, [
      user.id,
    ])) as { id: string }[];
    return { userId: user.id, walletId: wallet.id };
  };
  let fixtureSnapshotId: string | undefined;

  const harness: LedgerHarness = {
    db,
    moduleRef,
    dataSource,
    unitOfWork: moduleRef.get(UnitOfWork),
    ledger,
    chartOfAccounts,
    checks,
    reservations: moduleRef.get(ReservationService),
    reservationChecks,
    auth,
    payments,
    fx,
    createWallet,
    async newFlowIds(count) {
      const { userId } = await createWallet();
      const rows = (await dataSource.query(
        `INSERT INTO flow_instances (flow_type, state, user_id, completed_at)
         SELECT 'FUNDING', 'FAILED', $1, now() FROM generate_series(1, $2)
         RETURNING id`,
        [userId, count],
      )) as { id: string }[];
      return rows.map((row) => row.id);
    },
    async openUserAccount(currency, wallet) {
      const owner = wallet ?? (await createWallet());
      const account = await chartOfAccounts.openUserAccount(owner.walletId, currency);
      return { ...owner, accountId: account.id, currency };
    },
    fund(account, amountMinor) {
      return ledger.post({
        transaction: {
          type: TransactionType.FUNDING,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: new Date(),
          initiatedBy: 'job:test-funding',
          userId: account.userId,
        },
        entries: [
          { account: { systemAccount: 'BANK' }, direction: EntryDirection.DEBIT, amount: Money.of(amountMinor, account.currency) },
          { account: { accountId: account.accountId }, direction: EntryDirection.CREDIT, amount: Money.of(amountMinor, account.currency) },
        ],
      });
    },
    async conversionProvenance(input) {
      fixtureSnapshotId ??= (
        (await dataSource.query(
          `INSERT INTO exchange_rate_snapshots
             (provider, base_currency_code, provider_updated_at, provider_next_update_at, fetched_at, status)
           VALUES ('test-fixture', 'USD', now(), now() + interval '1 hour', now(), 'ACCEPTED')
           RETURNING id`,
        )) as { id: string }[]
      )[0].id;
      const [{ rate }] = (await dataSource.query(`SELECT ($1::numeric / $2::numeric)::text AS rate`, [
        input.targetAmountMinor.toString(),
        input.sourceAmountMinor.toString(),
      ])) as { rate: string }[];
      return {
        ...input,
        rateDisplay: rate,
        referenceRate: rate,
        rateProvider: 'test-fixture',
        rateFetchedAt: new Date(),
        rateProviderUpdatedAt: new Date(),
        rateSnapshotId: fixtureSnapshotId,
        spreadBasisPoints: 50,
      };
    },
    async balanceOf(accountId) {
      const [row] = (await dataSource.query(`SELECT balance_minor::text AS balance FROM accounts WHERE id = $1`, [
        accountId,
      ])) as { balance: string }[];
      return BigInt(row.balance);
    },
    async reservedOf(accountId) {
      const [row] = (await dataSource.query(`SELECT reserved_minor::text AS reserved FROM accounts WHERE id = $1`, [
        accountId,
      ])) as { reserved: string }[];
      return BigInt(row.reserved);
    },
    async snapshot() {
      const [row] = (await dataSource.query(`
        SELECT (SELECT count(*) FROM transactions)::int   AS transaction_count,
               (SELECT count(*) FROM ledger_entries)::int AS entry_count,
               (SELECT md5(coalesce(string_agg(
                  id::text || ':' || balance_minor || ':' || reserved_minor || ':' || version || ':' || coalesce(balance_entry_id::text, '-'),
                  ',' ORDER BY id), '')) FROM accounts) AS accounts_digest,
               (SELECT md5(coalesce(string_agg(
                  id::text || ':' || status || ':' || coalesce(corrected_by_transaction_id::text, '-'),
                  ',' ORDER BY id), '')) FROM transactions) AS transactions_digest,
               (SELECT md5(coalesce(string_agg(
                  id::text || ':' || status || ':' || coalesce(settled_minor::text, '-') || ':' ||
                  coalesce(settlement_transaction_id::text, '-') || ':' || coalesce(resolved_at::text, '-'),
                  ',' ORDER BY id), '')) FROM reservations) AS reservations_digest,
               (SELECT count(*) FROM flow_instances)::int AS flow_count,
               (SELECT count(*) FROM idempotency_keys)::int AS idempotency_key_count,
               (SELECT count(*) FROM users)::int         AS user_count,
               (SELECT count(*) FROM wallets)::int       AS wallet_count,
               (SELECT count(*) FROM outbox_events)::int AS outbox_event_count,
               (SELECT count(*) FROM audit_logs)::int    AS audit_log_count
      `)) as {
        transaction_count: number;
        entry_count: number;
        accounts_digest: string;
        transactions_digest: string;
        reservations_digest: string;
        flow_count: number;
        idempotency_key_count: number;
        user_count: number;
        wallet_count: number;
        outbox_event_count: number;
        audit_log_count: number;
      }[];
      return {
        transactionCount: row.transaction_count,
        entryCount: row.entry_count,
        accountsDigest: row.accounts_digest,
        transactionsDigest: row.transactions_digest,
        reservationsDigest: row.reservations_digest,
        flowCount: row.flow_count,
        idempotencyKeyCount: row.idempotency_key_count,
        userCount: row.user_count,
        walletCount: row.wallet_count,
        outboxEventCount: row.outbox_event_count,
        auditLogCount: row.audit_log_count,
      };
    },
    async expectCleanBooks() {
      const report = await checks.runAllChecks();
      expect({
        unbalancedCurrencies: report.unbalancedCurrencies,
        accountingEquationFailures: report.accountingEquationFailures,
        cachedBalanceMismatches: report.cachedBalanceMismatches,
        balanceContinuityBreaks: report.balanceContinuityBreaks,
        hashChainBreaks: report.hashChainBreaks,
        reservedBalanceMismatches: await reservationChecks.findReservedBalanceMismatches(),
      }).toEqual({
        unbalancedCurrencies: [],
        accountingEquationFailures: [],
        cachedBalanceMismatches: [],
        balanceContinuityBreaks: [],
        hashChainBreaks: [],
        reservedBalanceMismatches: [],
      });
      expect(report.isClean).toBe(true);
      return report;
    },
    async close() {
      if (auth) await auth.app.close();
      else await moduleRef.close();
      await psp?.stop();
      await paystackMock?.stop();
      await fxApi?.stop();
      await db.stop();
      await redis?.stop().catch(() => undefined);
    },
  };
  return harness;
}
