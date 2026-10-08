import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Request, Response } from 'express';
import { LosslessNumber, stringify } from 'lossless-json';
import { signPaystackWebhook } from '../modules/payments/paystack/webhooks/paystack-webhook-signature';
import { MOCK_TRANSFER_OPERATIONS, MockPaystackTransfers, MockTransferOperation } from './mock-paystack-transfers';

/**
 * A simulated Paystack (https://paystack.com/docs/api) for tests and local development (PAYSTACK_PLAN.md E). A real
 * HTTP server with Paystack's shapes as documented (checked 2026-10-01): `{status, message, data, meta}` envelopes,
 * amounts and ids as JSON NUMBERS (ids beyond 2^53 here, so a float anywhere shows), `400 "Transaction reference not
 * found"` on an unknown verify, `400 "Duplicate Transaction Reference"` on a reused reference, page-number lists, and
 * webhooks signed `x-paystack-signature` = hex HMAC-SHA512 of the raw body with the secret key.
 *
 * NOT part of the application: nothing under `src/modules` imports it. Every test and CI run points
 * `PAYSTACK_BASE_URL` here — never at the real Paystack.
 *
 * Scripting: `pay` (the customer pays — optionally another amount or currency than asked), `decline`, `setStatus`,
 * `hideFromVerify` (verify lags the write), `failNext` (5xx, 429, status:false on a 200, garbage, a bad field, hangs
 * before or after the effect), disputes, foreign transactions, and webhooks delivered on command (or automatically).
 */

export type MockPaystackStatus = 'success' | 'failed' | 'abandoned' | 'ongoing' | 'pending' | 'processing' | 'queued' | 'reversed';
export type MockPaystackOperation = 'initialize' | 'verify' | 'list_transactions' | 'list_disputes' | MockTransferOperation;
export type MockPaystackFault =
  | 'server_error'
  | 'rate_limited'
  | 'status_false_200'
  | 'malformed_json'
  | 'bad_field'
  | 'timeout_before_effect'
  | 'timeout_after_effect';

interface MockTransaction {
  id: string;
  reference: string;
  status: MockPaystackStatus;
  /** What was asked at initialize, and what the customer was actually charged (may differ: a scripted mismatch). */
  requestedAmount: string;
  amount: string;
  currency: string;
  email: string;
  callbackUrl: string | null;
  accessCode: string;
  createdAt: string;
  paidAt: string | null;
  gatewayResponse: string;
  hiddenVerifies: number;
}

interface MockDispute {
  id: string;
  transactionId: string;
  reference: string;
  status: 'awaiting-merchant-feedback' | 'awaiting-bank-feedback' | 'pending' | 'resolved';
  resolution: 'merchant-accepted' | 'declined' | null;
  refundAmount: string;
  currency: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MockPaystackWebhook {
  readonly event: string;
  readonly body: Buffer;
}

export type PaystackWebhookDeliverer = (body: Buffer, headers: Record<string, string>) => Promise<number>;

export interface MockPaystackOptions {
  readonly secretKey: string;
  /** Paystack's clock (paid_at, created_at, dispute times). Tests pass their TestClock. */
  readonly now?: () => Date;
  readonly autoDeliverWebhooks?: boolean;
  readonly deliverWebhook?: PaystackWebhookDeliverer;
  /** How long a timeout fault holds the response (longer than the client's timeout). */
  readonly hangMilliseconds?: number;
  /** Called at the start of every API request, before any effect (tests instrument "no DB transaction open"). */
  readonly onRequest?: (operation: MockPaystackOperation) => Promise<void>;
}

export interface MockPaystackStatistics {
  readonly requests: Readonly<Record<MockPaystackOperation, number>>;
  /** Transactions actually created by initialize, however many requests asked. */
  readonly effectiveInitializations: number;
}

/** Where an effect's answer goes when the fault says the answer is lost. */
const DISCARDED_RESPONSE: Response = (() => {
  const sink: Record<string, unknown> = {};
  for (const method of ['status', 'type', 'send', 'end', 'redirect']) sink[method] = () => sink;
  return sink as unknown as Response;
})();

const FIRST_TRANSACTION_ID = 9_007_199_254_740_993n; // 2^53 + 1: a float would make it even.

export class MockPaystack {
  private readonly transactions = new Map<string, MockTransaction>();
  private readonly disputes: MockDispute[] = [];
  private readonly faults = new Map<MockPaystackOperation, MockPaystackFault[]>();
  private readonly queue: MockPaystackWebhook[] = [];
  private readonly counts = Object.fromEntries(
    (['initialize', 'verify', 'list_transactions', 'list_disputes', ...MOCK_TRANSFER_OPERATIONS] as MockPaystackOperation[]).map((operation) => [operation, 0]),
  ) as Record<MockPaystackOperation, number>;
  /** The transfer side (W2): banks, resolve, recipients, transfers, balance and ledger. */
  readonly transfers: MockPaystackTransfers;
  private nextId = FIRST_TRANSACTION_ID;
  private nextDisputeId = 700_000;
  private initializations = 0;
  private deliverer: PaystackWebhookDeliverer | undefined;
  private server: Server | undefined;
  private baseUrl = '';
  private pageSize: number | undefined;
  private onRequest: ((operation: MockPaystackOperation) => Promise<void>) | undefined;

  constructor(private readonly options: MockPaystackOptions) {
    this.deliverer = options.deliverWebhook;
    this.onRequest = options.onRequest;
    this.transfers = new MockPaystackTransfers({
      now: () => this.now(),
      integrationId: '463433',
      emit: (event, data) => this.emit(event, data),
      handle: (operation, response, effect) => this.handle(operation, response, effect),
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    const app = express();
    // The raw text is kept too: the transfer routes read money losslessly (an integer, never a float).
    app.use(
      express.json({
        limit: '100kb',
        verify: (request, _response, buffer) => {
          (request as unknown as { rawBody?: string }).rawBody = buffer.toString('utf8');
        },
      }),
    );
    app.use(express.urlencoded({ extended: false }));
    // The hosted checkout (dev walkthrough): no key, like Paystack's.
    app.get('/checkout/:accessCode', (request, response) => this.checkoutPage(request, response));
    app.post('/checkout/:accessCode/:action', (request, response) => this.checkoutAction(request, response));
    app.use((request: Request, response: Response, next: NextFunction) => this.authenticate(request, response, next));
    app.post('/transaction/initialize', (request, response) => void this.handle('initialize', response, (into) => this.initialize(request, into)));
    app.get('/transaction/verify/:reference', (request, response) => void this.handle('verify', response, (into) => this.verify(request, into)));
    app.get('/transaction', (request, response) => void this.handle('list_transactions', response, (into) => this.listTransactions(request, into)));
    app.get('/dispute', (request, response) => void this.handle('list_disputes', response, (into) => this.listDisputes(request, into)));
    this.transfers.register(app);
    await new Promise<void>((resolve) => {
      this.server = app.listen(port, host, () => resolve());
    });
    const address = this.server?.address() as AddressInfo;
    this.baseUrl = `http://${host === '0.0.0.0' ? 'localhost' : host}:${address.port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  setDeliverer(deliverer: PaystackWebhookDeliverer): void {
    this.deliverer = deliverer;
  }

  setOnRequest(hook: ((operation: MockPaystackOperation) => Promise<void>) | undefined): void {
    this.onRequest = hook;
  }

  /** Smaller list pages, to exercise pagination. */
  setPageSize(size: number | undefined): void {
    this.pageSize = size;
  }

  // ── scripting ─────────────────────────────────────────────────────────────

  failNext(operation: MockPaystackOperation, fault: MockPaystackFault, times = 1): void {
    const list = this.faults.get(operation) ?? [];
    for (let i = 0; i < times; i += 1) list.push(fault);
    this.faults.set(operation, list);
  }

  clearFaults(): void {
    this.faults.clear();
  }

  /** The customer pays on the checkout. `amount` / `currency` script a Paystack charge that differs from the ask. */
  pay(reference: string, overrides: { amount?: string; currency?: string; at?: Date } = {}): void {
    const transaction = this.require(reference);
    transaction.status = 'success';
    transaction.amount = overrides.amount ?? transaction.requestedAmount;
    transaction.currency = overrides.currency ?? transaction.currency;
    transaction.paidAt = (overrides.at ?? this.now()).toISOString();
    transaction.gatewayResponse = 'Successful';
    this.emitCharge(transaction);
  }

  /** The card was declined (the customer may still retry on the same checkout). */
  decline(reference: string): void {
    const transaction = this.require(reference);
    transaction.status = 'failed';
    transaction.gatewayResponse = 'Declined';
  }

  setStatus(reference: string, status: MockPaystackStatus): void {
    this.require(reference).status = status;
  }

  /** Verify answers "not found" for the next `reads` reads (Paystack's read lagging its write). */
  hideFromVerify(reference: string, reads: number): void {
    this.require(reference).hiddenVerifies = reads;
  }

  /** A paid transaction nobody initialized through us (another app on the account, or a lost record). */
  createForeignTransaction(input: { reference?: string; amount: string; currency: string; status?: MockPaystackStatus }): string {
    const reference = input.reference ?? `foreign-${randomBytes(6).toString('hex')}`;
    const transaction = this.createTransaction(reference, input.amount, input.currency, 'foreign@example.com', null);
    transaction.status = input.status ?? 'success';
    if (transaction.status === 'success') transaction.paidAt = this.now().toISOString();
    return reference;
  }

  openDispute(reference: string, input: { refundAmount?: string } = {}): string {
    const transaction = this.require(reference);
    const dispute: MockDispute = {
      id: String((this.nextDisputeId += 1)),
      transactionId: transaction.id,
      reference,
      status: 'awaiting-merchant-feedback',
      resolution: null,
      refundAmount: input.refundAmount ?? transaction.amount,
      currency: transaction.currency,
      createdAt: this.now().toISOString(),
      resolvedAt: null,
    };
    this.disputes.push(dispute);
    this.emit('charge.dispute.create', this.disputeData(dispute));
    return dispute.id;
  }

  resolveDispute(disputeId: string, resolution: 'merchant-accepted' | 'declined'): void {
    const dispute = this.disputes.find((each) => each.id === disputeId);
    if (!dispute) throw new Error(`mock Paystack: no dispute ${disputeId}`);
    dispute.status = 'resolved';
    dispute.resolution = resolution;
    dispute.resolvedAt = this.now().toISOString();
    this.emit('charge.dispute.resolve', this.disputeData(dispute));
  }

  /** Every transaction for one of our references (normally exactly one). */
  transactionsFor(reference: string): number {
    return [...this.transactions.values()].filter((transaction) => transaction.reference === reference).length;
  }

  find(reference: string): Readonly<MockTransaction> | undefined {
    return this.transactions.get(reference);
  }

  statistics(): MockPaystackStatistics {
    return { requests: { ...this.counts }, effectiveInitializations: this.initializations };
  }

  // ── webhooks ──────────────────────────────────────────────────────────────

  pendingWebhooks(): readonly MockPaystackWebhook[] {
    return [...this.queue];
  }

  dropWebhooks(): void {
    this.queue.length = 0;
  }

  /** Deliver every queued webhook (signed), in order. Returns their HTTP statuses. */
  async deliverAll(): Promise<number[]> {
    const statuses: number[] = [];
    while (this.queue.length > 0) {
      const webhook = this.queue.shift() as MockPaystackWebhook;
      statuses.push(await this.send(webhook.body));
    }
    return statuses;
  }

  /** Send raw bytes as a webhook — signed with `signingKey` (default: the real key), or with no/garbage signature. */
  send(body: Buffer, signature: string | null | { signingKey: string } = null): Promise<number> {
    if (!this.deliverer) throw new Error('mock Paystack: no webhook deliverer');
    const header =
      signature === null ? signPaystackWebhook(this.options.secretKey, body) : typeof signature === 'string' ? signature : signPaystackWebhook(signature.signingKey, body);
    return this.deliverer(body, { 'content-type': 'application/json', 'x-paystack-signature': header, 'user-agent': 'Paystack-Mock' });
  }

  /** The charge.success body Paystack would send for a reference (to replay or tamper with in tests). */
  chargeSuccessBody(reference: string): Buffer {
    return this.webhookBody('charge.success', this.transactionData(this.require(reference)));
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private authenticate(request: Request, response: Response, next: NextFunction): void {
    const header = request.headers.authorization ?? '';
    const expected = Buffer.from(`Bearer ${this.options.secretKey}`);
    const given = Buffer.from(header);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.json(response, 401, { status: false, message: 'Invalid key', meta: { nextStep: 'Ensure that you provide the correct authorization key for the request' }, type: 'validation_error', code: 'invalid_Key' });
      return;
    }
    next();
  }

  private async handle(operation: MockPaystackOperation, response: Response, effect: (into: Response) => unknown): Promise<void> {
    this.counts[operation] += 1;
    await this.onRequest?.(operation);
    const fault = this.faults.get(operation)?.shift();
    const hang = this.options.hangMilliseconds ?? 600;
    switch (fault) {
      case 'server_error':
        this.json(response, 500, { status: false, message: 'An error occurred' });
        return;
      case 'rate_limited':
        this.json(response, 429, { status: false, message: 'Too many requests' });
        return;
      case 'status_false_200':
        this.json(response, 200, { status: false, message: 'Something went wrong' });
        return;
      case 'malformed_json':
        response.status(200).type('application/json').send('{"status":true,"data":');
        return;
      case 'bad_field':
        this.raw(response, 200, '{"status":true,"message":"ok","data":{"id":1,"reference":"x","status":"success","amount":100.5,"currency":"NGN","paid_at":"2026-01-01T00:00:00.000Z"},"meta":{"page":1,"pageCount":1}}');
        return;
      case 'timeout_before_effect':
        await new Promise((resolve) => setTimeout(resolve, hang));
        if (!response.headersSent) response.status(504).end();
        return;
      case 'timeout_after_effect':
        // The effect happens; its answer is lost (written nowhere), then the connection hangs.
        try {
          effect(DISCARDED_RESPONSE);
        } catch {
          // reported as the hang
        }
        await new Promise((resolve) => setTimeout(resolve, hang));
        if (!response.headersSent) response.status(504).end();
        return;
      default:
        effect(response);
    }
  }

  private initialize(request: Request, response: Response): void {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reference = typeof body.reference === 'string' ? body.reference : '';
    const amount = typeof body.amount === 'string' ? body.amount : '';
    const currency = typeof body.currency === 'string' ? body.currency : 'NGN';
    const email = typeof body.email === 'string' ? body.email : '';
    if (!/^[A-Za-z0-9.=-]{1,128}$/.test(reference)) {
      this.json(response, 400, { status: false, message: 'Invalid transaction reference' });
      return;
    }
    if (!/^[1-9]\d{0,17}$/.test(amount)) {
      this.json(response, 400, { status: false, message: 'Invalid Amount Sent' });
      return;
    }
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      this.json(response, 400, { status: false, message: 'Invalid Email Address Passed' });
      return;
    }
    if (this.transactions.has(reference)) {
      this.json(response, 400, { status: false, message: 'Duplicate Transaction Reference' });
      return;
    }
    const transaction = this.createTransaction(reference, amount, currency, email, typeof body.callback_url === 'string' ? body.callback_url : null);
    this.initializations += 1;
    this.json(response, 200, {
      status: true,
      message: 'Authorization URL created',
      data: { authorization_url: `${this.baseUrl}/checkout/${transaction.accessCode}`, access_code: transaction.accessCode, reference },
    });
  }

  private verify(request: Request, response: Response): void {
    const reference = String(request.params.reference);
    const transaction = this.transactions.get(reference);
    if (!transaction || transaction.hiddenVerifies > 0) {
      if (transaction) transaction.hiddenVerifies -= 1;
      this.json(response, 400, { status: false, message: 'Transaction reference not found' });
      return;
    }
    this.raw(response, 200, stringify({ status: true, message: 'Verification successful', data: this.transactionData(transaction) }) ?? '');
  }

  private listTransactions(request: Request, response: Response): void {
    const { from, to, page, perPage } = this.range(request);
    const matching = [...this.transactions.values()]
      .filter((transaction) => transaction.createdAt >= from && transaction.createdAt <= to)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    this.page(response, matching.map((transaction) => this.transactionData(transaction)), page, perPage);
  }

  private listDisputes(request: Request, response: Response): void {
    const { from, to, page, perPage } = this.range(request);
    const transactionId = typeof request.query.transaction === 'string' ? request.query.transaction : undefined;
    const matching = this.disputes.filter(
      (dispute) => dispute.createdAt >= from && dispute.createdAt <= to && (transactionId === undefined || dispute.transactionId === transactionId),
    );
    this.page(response, matching.map((dispute) => this.disputeData(dispute)), page, perPage);
  }

  private range(request: Request): { from: string; to: string; page: number; perPage: number } {
    const query = request.query as Record<string, string | undefined>;
    return {
      from: query.from ? new Date(query.from).toISOString() : '0000-01-01T00:00:00.000Z',
      to: query.to ? new Date(query.to).toISOString() : '9999-12-31T23:59:59.999Z',
      page: Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1),
      perPage: this.pageSize ?? Math.max(1, Number.parseInt(query.perPage ?? '50', 10) || 50),
    };
  }

  private page(response: Response, items: unknown[], page: number, perPage: number): void {
    const pageCount = Math.max(1, Math.ceil(items.length / perPage));
    const slice = items.slice((page - 1) * perPage, page * perPage);
    this.raw(
      response,
      200,
      stringify({
        status: true,
        message: 'Retrieved',
        data: slice,
        meta: { total: items.length, skipped: (page - 1) * perPage, perPage, page, pageCount },
      }) ?? '',
    );
  }

  private checkoutPage(request: Request, response: Response): void {
    const transaction = [...this.transactions.values()].find((each) => each.accessCode === request.params.accessCode);
    if (!transaction) {
      response.status(404).send('Unknown checkout');
      return;
    }
    const naira = `${transaction.currency} ${transaction.requestedAmount} (minor units)`;
    response.type('html').send(
      `<!doctype html><title>Mock Paystack checkout</title><body style="font-family:system-ui;margin:3rem">` +
        `<h1>Mock Paystack checkout</h1><p>Pay ${naira} for reference <code>${transaction.reference}</code>.</p>` +
        `<form method="post" action="/checkout/${transaction.accessCode}/pay"><button>Pay (success)</button></form>` +
        `<form method="post" action="/checkout/${transaction.accessCode}/decline"><button>Decline</button></form></body>`,
    );
  }

  private checkoutAction(request: Request, response: Response): void {
    const transaction = [...this.transactions.values()].find((each) => each.accessCode === request.params.accessCode);
    if (!transaction) {
      response.status(404).send('Unknown checkout');
      return;
    }
    if (request.params.action === 'pay') this.pay(transaction.reference);
    else this.decline(transaction.reference);
    const target = transaction.callbackUrl ? `${transaction.callbackUrl}${transaction.callbackUrl.includes('?') ? '&' : '?'}reference=${encodeURIComponent(transaction.reference)}` : null;
    if (target) response.redirect(303, target);
    else response.type('html').send(`<p>Done: ${transaction.status}. You can close this page.</p>`);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private createTransaction(reference: string, amount: string, currency: string, email: string, callbackUrl: string | null): MockTransaction {
    const transaction: MockTransaction = {
      id: (this.nextId += 1n).toString(),
      reference,
      status: 'abandoned',
      requestedAmount: amount,
      amount,
      currency,
      email,
      callbackUrl,
      accessCode: randomBytes(8).toString('hex'),
      createdAt: this.now().toISOString(),
      paidAt: null,
      gatewayResponse: 'The transaction was not completed',
      hiddenVerifies: 0,
    };
    this.transactions.set(reference, transaction);
    return transaction;
  }

  private transactionData(transaction: MockTransaction): Record<string, unknown> {
    return {
      id: new LosslessNumber(transaction.id),
      domain: 'test',
      status: transaction.status,
      reference: transaction.reference,
      receipt_number: null,
      amount: new LosslessNumber(transaction.amount),
      message: null,
      gateway_response: transaction.gatewayResponse,
      paid_at: transaction.paidAt,
      created_at: transaction.createdAt,
      channel: 'card',
      currency: transaction.currency,
      ip_address: '100.64.11.35',
      metadata: '',
      fees: new LosslessNumber('100'),
      authorization: transaction.paidAt
        ? { authorization_code: 'AUTH_mock', bin: '408408', last4: '4081', exp_month: '12', exp_year: '2030', card_type: 'visa ', bank: 'TEST BANK', reusable: true, signature: 'SIG_mock' }
        : {},
      customer: { id: new LosslessNumber('89929267'), email: transaction.email, customer_code: 'CUS_mock', first_name: null, last_name: null },
      paidAt: transaction.paidAt,
      createdAt: transaction.createdAt,
      requested_amount: new LosslessNumber(transaction.requestedAmount),
      transaction_date: transaction.createdAt,
    };
  }

  private disputeData(dispute: MockDispute): Record<string, unknown> {
    return {
      id: new LosslessNumber(dispute.id),
      refund_amount: new LosslessNumber(dispute.refundAmount),
      currency: dispute.currency,
      status: dispute.status,
      resolution: dispute.resolution,
      domain: 'test',
      category: 'chargeback',
      createdAt: dispute.createdAt,
      resolvedAt: dispute.resolvedAt,
      transaction: { id: new LosslessNumber(dispute.transactionId), reference: dispute.reference, currency: dispute.currency },
    };
  }

  private emitCharge(transaction: MockTransaction): void {
    this.emit('charge.success', this.transactionData(transaction));
  }

  private webhookBody(event: string, data: Record<string, unknown>): Buffer {
    return Buffer.from(stringify({ event, data }) ?? '', 'utf8');
  }

  private emit(event: string, data: Record<string, unknown>): void {
    const webhook = { event, body: this.webhookBody(event, data) };
    if (this.options.autoDeliverWebhooks && this.deliverer) {
      void this.send(webhook.body).catch(() => undefined);
      return;
    }
    this.queue.push(webhook);
  }

  private require(reference: string): MockTransaction {
    const transaction = this.transactions.get(reference);
    if (!transaction) throw new Error(`mock Paystack: no transaction ${reference}`);
    return transaction;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private json(response: Response, status: number, body: unknown): void {
    response.status(status).type('application/json').send(JSON.stringify(body));
  }

  private raw(response: Response, status: number, text: string): void {
    response.status(status).type('application/json').send(text);
  }
}
