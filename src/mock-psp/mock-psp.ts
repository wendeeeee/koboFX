import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { NextFunction, Request, Response } from 'express';
import { signWebhook } from '../modules/payments/webhooks/webhook-signature';

/**
 * A simulated payment service provider (design §15 item 5: "funding is simulated behind a
 * real port"). A real HTTP server, so the adapter really sees timeouts, 5xx, `200`s with
 * error bodies, malformed JSON and signed webhooks. NOT part of the application: nothing
 * under `src/modules` imports it.
 *
 * Behaviour is deterministic and scriptable, for tests and for a developer:
 * - the payment method token picks the scenario: `tok_decline_<code>` declines,
 *   `tok_expire_*` authorizes but the hold has lapsed at capture, `tok_capture_fail_*`
 *   fails at capture, anything else authorizes;
 * - captures go `capture_pending` and complete immediately, after a delay, or on command;
 * - reads can lag writes by N reads (`setReadLag`), as real eventually-consistent APIs do;
 * - `failNext` injects faults per operation; webhooks are queued and can be delivered,
 *   duplicated, reordered, dropped, or sent automatically.
 * - writes are idempotent per `Idempotency-Key`: a repeat returns the ORIGINAL response.
 */

export type MockPaymentStatus =
  | 'authorized'
  | 'capture_pending'
  | 'captured'
  | 'declined'
  | 'expired'
  | 'voided'
  | 'capture_failed'
  | 'charged_back';

export type MockOperation = 'authorize' | 'capture' | 'void' | 'get' | 'list' | 'list_settlements' | 'get_settlement' | 'list_chargebacks';

export type FaultKind =
  | 'server_error'
  | 'rate_limited'
  | 'error_body_200'
  | 'malformed_json'
  | 'bad_field'
  | 'timeout_before_effect'
  | 'timeout_after_effect';

export type CaptureCompletion = 'immediate' | 'manual' | { readonly afterMilliseconds: number };

interface MockPayment {
  id: string;
  reference: string;
  status: MockPaymentStatus;
  amount: string;
  currency: string;
  capturedAt: string | null;
  declineCode: string | null;
  chargeback: { id: string; amount: string; created_at: string } | null;
  createdAt: string;
  scenario: 'normal' | 'expire' | 'capture_fail';
  /** What reads return while they lag; with `lagReadsLeft` of them left. */
  laggingView: Record<string, unknown> | null;
  lagReadsLeft: number;
}

export interface MockWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly paymentId: string;
  readonly body: Buffer;
}

export interface MockPspStatistics {
  readonly requests: Readonly<Record<MockOperation, number>>;
  /** Payments actually created (an authorization's effect), however many requests asked. */
  readonly effectiveAuthorizations: number;
  /** Captures actually applied (authorized → capture_pending). */
  readonly effectiveCaptures: number;
  readonly effectiveVoids: number;
}

export type WebhookDeliverer = (body: Buffer, headers: Record<string, string>) => Promise<number>;

export interface MockPspOptions {
  readonly secretKey: string;
  readonly webhookSecret: Buffer;
  readonly captureCompletion?: CaptureCompletion;
  /** Send each webhook as it is emitted (dev). Tests usually deliver on command. */
  readonly autoDeliverWebhooks?: boolean;
  readonly deliverWebhook?: WebhookDeliverer;
  /** How long a timeout fault holds the response (longer than the client's timeout). */
  readonly hangMilliseconds?: number;
  /** The PSP's clock (capture, chargeback and settlement times). Tests pass their TestClock. */
  readonly now?: () => Date;
}

interface MockSettlementLine {
  id: string;
  type: 'payment' | 'chargeback';
  payment_id: string;
  chargeback_id: string | null;
  currency: string;
  amount: string;
  fee: string;
}

interface MockSettlementBatch {
  id: string;
  currency: string;
  status: 'paid' | 'pending';
  settledAt: string;
  /** Listed only once the PSP's clock reaches this (a late batch is published after it settled). */
  visibleFrom: string;
  lines: MockSettlementLine[];
  /** Added to the stated gross only (a report whose totals don't add up). */
  grossDelta: bigint;
}

export interface SettleOptions {
  readonly currency: string;
  /** Which captured payments to pay out; default every captured (or charged back) unsettled one. */
  readonly paymentIds?: readonly string[];
  /** Deduct chargebacks not yet deducted (default true). */
  readonly deductChargebacks?: boolean;
  readonly settledAt?: Date;
  /** When the batch becomes visible in the list (default: when it settled). */
  readonly visibleFrom?: Date;
  readonly status?: 'paid' | 'pending';
  /** The PSP's fee: `floor(amount × bps / 10,000) + fixed` — its rounding, not ours. Default 150 bps. */
  readonly feeBasisPoints?: number;
  readonly fixedFeeMinor?: bigint;
  readonly chargebackFeeMinor?: bigint;
  // Scripted faults (Phase 9).
  /** Leave these payments out (a missing line); they stay unsettled at the PSP. */
  readonly omit?: readonly string[];
  /** Pay these payments out with a different amount (a wrong amount). */
  readonly alterAmounts?: Readonly<Record<string, bigint>>;
  /** Add lines for payment ids the PSP's own API does not know. */
  readonly unknownLines?: number;
  /** Add this to the stated gross (lines no longer add up to the totals). */
  readonly grossDelta?: bigint;
}

interface StoredWrite {
  readonly statusCode: number;
  readonly body: unknown;
}

const OPERATIONS: readonly MockOperation[] = ['authorize', 'capture', 'void', 'get', 'list', 'list_settlements', 'get_settlement', 'list_chargebacks'];

export class MockPsp {
  private readonly payments = new Map<string, MockPayment>();
  private readonly byReference = new Map<string, string>();
  private readonly writes = new Map<string, StoredWrite>();
  private readonly faults = new Map<MockOperation, FaultKind[]>();
  private readonly queue: MockWebhookEvent[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly requests: Record<MockOperation, number> = {
    authorize: 0, capture: 0, void: 0, get: 0, list: 0, list_settlements: 0, get_settlement: 0, list_chargebacks: 0,
  };
  private readonly batches = new Map<string, MockSettlementBatch>();
  /** Payment id → the batch that paid it out; chargeback id → the batch that deducted it. */
  private readonly settledPayments = new Map<string, string>();
  private readonly deductedChargebacks = new Map<string, string>();
  private pageSize = 100;
  private readonly now: () => Date;
  private effectiveAuthorizations = 0;
  private effectiveCaptures = 0;
  private effectiveVoids = 0;
  private eventSequence = 0;
  private readLag = 0;
  private captureCompletion: CaptureCompletion;
  private deliverer: WebhookDeliverer | undefined;
  private server: Server | undefined;

  constructor(private readonly options: MockPspOptions) {
    this.captureCompletion = options.captureCompletion ?? 'manual';
    this.deliverer = options.deliverWebhook;
    this.now = options.now ?? (() => new Date());
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    const app = this.buildApp();
    await new Promise<void>((resolve) => {
      this.server = app.listen(port, host, () => resolve());
    });
    const address = this.server!.address() as AddressInfo;
    return `http://${host}:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  // ── scripting (tests and the dev control API) ─────────────────────────────

  setDeliverer(deliverer: WebhookDeliverer): void {
    this.deliverer = deliverer;
  }

  setCaptureCompletion(completion: CaptureCompletion): void {
    this.captureCompletion = completion;
  }

  /** After every state change, the next `reads` reads of that payment show the previous state. */
  setReadLag(reads: number): void {
    this.readLag = reads;
  }

  failNext(operation: MockOperation, kind: FaultKind, count = 1): void {
    const queue = this.faults.get(operation) ?? [];
    for (let index = 0; index < count; index += 1) queue.push(kind);
    this.faults.set(operation, queue);
  }

  clearFaults(): void {
    this.faults.clear();
  }

  statistics(): MockPspStatistics {
    return {
      requests: { ...this.requests },
      effectiveAuthorizations: this.effectiveAuthorizations,
      effectiveCaptures: this.effectiveCaptures,
      effectiveVoids: this.effectiveVoids,
    };
  }

  paymentByReference(reference: string): Record<string, unknown> | undefined {
    const id = this.byReference.get(reference);
    return id ? this.view(this.payments.get(id)!) : undefined;
  }

  /** The PSP's current truth for a payment (no lag). */
  statusOf(paymentId: string): MockPaymentStatus | undefined {
    return this.payments.get(paymentId)?.status;
  }

  completeCapture(paymentId: string): void {
    const payment = this.require(paymentId);
    if (payment.status !== 'capture_pending') throw new Error(`Payment ${paymentId} is ${payment.status}, not capture_pending`);
    this.change(payment, { status: 'captured', capturedAt: this.now().toISOString() });
  }

  expireAuthorization(paymentId: string): void {
    const payment = this.require(paymentId);
    if (payment.status !== 'authorized') throw new Error(`Payment ${paymentId} is ${payment.status}, not authorized`);
    this.change(payment, { status: 'expired' });
  }

  chargeback(paymentId: string, amount?: string): void {
    const payment = this.require(paymentId);
    if (payment.status !== 'captured') throw new Error(`Payment ${paymentId} is ${payment.status}, not captured`);
    this.change(payment, {
      status: 'charged_back',
      chargeback: { id: `cb_${randomBytes(8).toString('hex')}`, amount: amount ?? payment.amount, created_at: this.now().toISOString() },
    });
  }

  /** Webhooks emitted and not yet delivered or dropped, oldest first. */
  pendingWebhooks(): readonly MockWebhookEvent[] {
    return [...this.queue];
  }

  /** Remove an event from the queue without delivering it (a lost webhook). */
  drop(eventId: string): void {
    const index = this.queue.findIndex((event) => event.id === eventId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  /**
   * Deliver one queued event `times` times (duplicates) and remove it from the queue.
   * Returns the HTTP statuses our API answered.
   */
  async deliver(eventId: string, times = 1): Promise<number[]> {
    const event = this.queue.find((candidate) => candidate.id === eventId);
    if (!event) throw new Error(`No pending webhook ${eventId}`);
    this.drop(eventId);
    const statuses: number[] = [];
    for (let index = 0; index < times; index += 1) statuses.push(await this.send(event.body));
    return statuses;
  }

  /** Deliver every pending event, in emission order or reversed. */
  async deliverAll(order: 'emitted' | 'reversed' = 'emitted'): Promise<number[]> {
    const events = order === 'emitted' ? [...this.queue] : [...this.queue].reverse();
    const statuses: number[] = [];
    for (const event of events) statuses.push(...(await this.deliver(event.id)));
    return statuses;
  }

  /**
   * A signed webhook about a payment that says whatever we like — e.g. "captured" while
   * the API still says authorized (a premature or lying hint). Queued like any other.
   */
  emitWebhook(paymentId: string, type: string): MockWebhookEvent {
    const payment = this.require(paymentId);
    return this.enqueue(type, { ...this.view(payment), status: type.replace(/^payment\./, '') });
  }

  /** Sign bytes the way this PSP does (for tests that craft deliveries). */
  sign(body: Buffer, timestampSeconds = Math.floor(Date.now() / 1000)): string {
    return signWebhook(this.options.webhookSecret, body, timestampSeconds);
  }

  // ── settlement (Phase 9) ─────────────────────────────────────────────────

  /** Page size of every list (payments by date, settlements, a report's lines). */
  setPageSize(size: number): void {
    this.pageSize = size;
  }

  /**
   * A captured payment we never initiated: its reference is no flow of ours (another
   * integration, a dashboard charge). Money from someone we cannot identify.
   */
  createForeignPayment(amount: string, currency: string): string {
    const now = this.now().toISOString();
    const payment: MockPayment = {
      id: `pay_${randomBytes(10).toString('hex')}`,
      reference: `foreign-${randomBytes(6).toString('hex')}`,
      status: 'captured',
      amount,
      currency,
      capturedAt: now,
      declineCode: null,
      chargeback: null,
      createdAt: now,
      scenario: 'normal',
      laggingView: null,
      lagReadsLeft: 0,
    };
    this.payments.set(payment.id, payment);
    this.byReference.set(payment.reference, payment.id);
    return payment.id;
  }

  /** The PSP loses a payment (its API 404s it from now on): a deposit we booked that the PSP does not have. */
  forget(paymentId: string): void {
    const payment = this.require(paymentId);
    this.payments.delete(paymentId);
    this.byReference.delete(payment.reference);
  }

  /** Pay out a batch (T+X is the caller's choice of `settledAt`). Returns the batch id. */
  settle(options: SettleOptions): string {
    const currency = options.currency;
    const settledAt = options.settledAt ?? this.now();
    const basisPoints = BigInt(options.feeBasisPoints ?? 150);
    const fixed = options.fixedFeeMinor ?? 0n;
    const omit = new Set(options.omit ?? []);
    const payable = (payment: MockPayment) =>
      payment.currency === currency &&
      (payment.status === 'captured' || payment.status === 'charged_back') &&
      !this.settledPayments.has(payment.id) &&
      !omit.has(payment.id);
    const chosen = options.paymentIds
      ? options.paymentIds.map((id) => this.require(id)).filter(payable)
      : [...this.payments.values()].filter(payable);
    const batchId = `stl_${randomBytes(8).toString('hex')}`;
    const lines: MockSettlementLine[] = [];
    let sequence = 0;
    const lineId = () => `${batchId}_l${String((sequence += 1)).padStart(4, '0')}`;
    for (const payment of chosen) {
      const amount = BigInt(payment.amount) + (options.alterAmounts?.[payment.id] ?? 0n);
      lines.push({
        id: lineId(),
        type: 'payment',
        payment_id: payment.id,
        chargeback_id: null,
        currency,
        amount: amount.toString(),
        fee: ((amount * basisPoints) / 10_000n + fixed).toString(),
      });
      this.settledPayments.set(payment.id, batchId);
    }
    for (let index = 0; index < (options.unknownLines ?? 0); index += 1) {
      lines.push({
        id: lineId(),
        type: 'payment',
        payment_id: `pay_unknown_${randomBytes(6).toString('hex')}`,
        chargeback_id: null,
        currency,
        amount: '100000',
        fee: '1500',
      });
    }
    if (options.deductChargebacks !== false) {
      for (const payment of this.payments.values()) {
        const chargeback = payment.chargeback;
        if (payment.currency !== currency || !chargeback || this.deductedChargebacks.has(chargeback.id) || omit.has(payment.id)) {
          continue;
        }
        lines.push({
          id: lineId(),
          type: 'chargeback',
          payment_id: payment.id,
          chargeback_id: chargeback.id,
          currency,
          amount: chargeback.amount,
          fee: (options.chargebackFeeMinor ?? 0n).toString(),
        });
        this.deductedChargebacks.set(chargeback.id, batchId);
      }
    }
    this.batches.set(batchId, {
      id: batchId,
      currency,
      status: options.status ?? 'paid',
      settledAt: settledAt.toISOString(),
      visibleFrom: (options.visibleFrom ?? settledAt).toISOString(),
      lines,
      grossDelta: options.grossDelta ?? 0n,
    });
    return batchId;
  }

  /** The same lines paid out again under a new batch id (a duplicated batch). */
  reissue(batchId: string, options: { settledAt?: Date } = {}): string {
    const original = this.requireBatch(batchId);
    const copyId = `stl_${randomBytes(8).toString('hex')}`;
    const settledAt = (options.settledAt ?? this.now()).toISOString();
    this.batches.set(copyId, {
      ...original,
      id: copyId,
      settledAt,
      visibleFrom: settledAt,
      lines: original.lines.map((line, index) => ({ ...line, id: `${copyId}_l${String(index + 1).padStart(4, '0')}` })),
    });
    return copyId;
  }

  /** Change a published report after the fact (a corrected batch): every fee + `feeDelta`. */
  revise(batchId: string, feeDelta: bigint): void {
    const batch = this.requireBatch(batchId);
    batch.lines = batch.lines.map((line) => ({ ...line, fee: (BigInt(line.fee) + feeDelta).toString() }));
  }

  /** Make a pending batch paid (or back), and visible now. */
  publish(batchId: string, status: 'paid' | 'pending' = 'paid'): void {
    const batch = this.requireBatch(batchId);
    batch.status = status;
    batch.visibleFrom = this.now().toISOString();
  }

  batchIds(): string[] {
    return [...this.batches.keys()];
  }

  /** The whole report as the API would serve it on one page, for assertions. */
  report(batchId: string): Record<string, unknown> {
    const batch = this.requireBatch(batchId);
    return this.reportView(batch, batch.lines, null);
  }

  private requireBatch(batchId: string): MockSettlementBatch {
    const batch = this.batches.get(batchId);
    if (!batch) throw new Error(`Unknown settlement batch ${batchId}`);
    return batch;
  }

  /** Totals as the PSP computes them from its lines (plus any scripted `grossDelta`). */
  private reportView(
    batch: MockSettlementBatch,
    lines: readonly MockSettlementLine[],
    nextCursor: string | null,
  ): Record<string, unknown> {
    let gross = 0n;
    let fees = 0n;
    let chargebacks = 0n;
    for (const line of batch.lines) {
      fees += BigInt(line.fee);
      if (line.type === 'payment') gross += BigInt(line.amount);
      else chargebacks += BigInt(line.amount);
    }
    return {
      id: batch.id,
      object: 'settlement',
      currency: batch.currency,
      status: batch.status,
      settled_at: batch.settledAt,
      gross: (gross + batch.grossDelta).toString(),
      fees: fees.toString(),
      chargebacks: chargebacks.toString(),
      net: (gross - fees - chargebacks).toString(),
      line_count: batch.lines.length,
      bank_reference: `BNK${batch.id.slice(4, 12).toUpperCase()}`,
      lines: { object: 'list', data: lines, next_cursor: nextCursor },
    };
  }

  /** Offset pagination behind an opaque cursor. */
  private page<T>(items: readonly T[], cursor: unknown): { data: T[]; next_cursor: string | null } {
    const decoded = typeof cursor === 'string' ? Buffer.from(cursor, 'base64url').toString() : '';
    const offset = /^\d+$/.test(decoded) ? Number(decoded) : 0;
    const data = items.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize < items.length ? Buffer.from(String(offset + this.pageSize)).toString('base64url') : null;
    return { data, next_cursor: next };
  }

  private inRange(value: string, request: Request, field: string): boolean {
    const from = request.query[`${field}_from`];
    const to = request.query[`${field}_to`];
    const time = Date.parse(value);
    return (typeof from !== 'string' || time >= Date.parse(from)) && (typeof to !== 'string' || time < Date.parse(to));
  }

  private listByCreation(request: Request): StoredWrite {
    const payments = [...this.payments.values()]
      .filter((payment) => this.inRange(payment.createdAt, request, 'created'))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((payment) => this.view(payment));
    return { statusCode: 200, body: { object: 'list', ...this.page(payments, request.query.cursor) } };
  }

  private listChargebacks(request: Request): StoredWrite {
    const chargebacks = [...this.payments.values()]
      .flatMap((payment) => (payment.chargeback ? [{ payment, chargeback: payment.chargeback }] : []))
      .filter(({ chargeback }) => this.inRange(chargeback.created_at, request, 'created'))
      .sort((a, b) => a.chargeback.created_at.localeCompare(b.chargeback.created_at) || a.chargeback.id.localeCompare(b.chargeback.id))
      .map(({ payment, chargeback }) => ({
        id: chargeback.id,
        object: 'chargeback',
        payment_id: payment.id,
        amount: chargeback.amount,
        currency: payment.currency,
        created_at: chargeback.created_at,
        reason: 'fraudulent',
      }));
    return { statusCode: 200, body: { object: 'list', ...this.page(chargebacks, request.query.cursor) } };
  }

  private listSettlements(request: Request): StoredWrite {
    const now = this.now().getTime();
    const batches = [...this.batches.values()]
      .filter((batch) => Date.parse(batch.visibleFrom) <= now && this.inRange(batch.settledAt, request, 'settled'))
      .sort((a, b) => a.settledAt.localeCompare(b.settledAt) || a.id.localeCompare(b.id))
      .map((batch) => ({ id: batch.id, object: 'settlement', currency: batch.currency, status: batch.status, settled_at: batch.settledAt }));
    return { statusCode: 200, body: { object: 'list', ...this.page(batches, request.query.cursor) } };
  }

  private getSettlement(batchId: string, request: Request): StoredWrite {
    const batch = this.batches.get(batchId);
    if (!batch || Date.parse(batch.visibleFrom) > this.now().getTime()) {
      return { statusCode: 404, body: { error: { code: 'settlement_not_found' } } };
    }
    const { data, next_cursor } = this.page(batch.lines, request.query.cursor);
    return { statusCode: 200, body: this.reportView(batch, data, next_cursor) };
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private buildApp(): express.Express {
    const app = express();
    app.use(express.json({ limit: '100kb' }));
    app.use((request: Request, response: Response, next: NextFunction) => {
      const presented = Buffer.from(request.header('authorization') ?? '');
      const expected = Buffer.from(`Bearer ${this.options.secretKey}`);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        response.status(401).json({ error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' } });
        return;
      }
      next();
    });

    app.post('/v1/payments', (request, response) => void this.handle('authorize', request, response, () => this.authorize(request)));
    app.post('/v1/payments/:id/capture', (request, response) =>
      void this.handle('capture', request, response, () => this.capture(String(request.params.id), request)),
    );
    app.post('/v1/payments/:id/void', (request, response) =>
      void this.handle('void', request, response, () => this.voidPayment(String(request.params.id))),
    );
    app.get('/v1/payments/:id', (request, response) =>
      void this.handle('get', request, response, () => this.read(String(request.params.id))),
    );
    app.get('/v1/payments', (request, response) =>
      void this.handle('list', request, response, () =>
        request.query.reference !== undefined ? this.list(String(request.query.reference)) : this.listByCreation(request),
      ),
    );
    app.get('/v1/chargebacks', (request, response) =>
      void this.handle('list_chargebacks', request, response, () => this.listChargebacks(request)),
    );
    app.get('/v1/settlements', (request, response) =>
      void this.handle('list_settlements', request, response, () => this.listSettlements(request)),
    );
    app.get('/v1/settlements/:id', (request, response) =>
      void this.handle('get_settlement', request, response, () => this.getSettlement(String(request.params.id), request)),
    );

    // Dev control surface (the same secret): complete a capture, charge back, deliver.
    app.post('/__control/payments/:id/complete-capture', (request, response) =>
      this.control(response, () => this.completeCapture(String(request.params.id))),
    );
    app.post('/__control/payments/:id/chargeback', (request, response) =>
      this.control(response, () => this.chargeback(String(request.params.id), request.body?.amount as string | undefined)),
    );
    app.post('/__control/webhooks/deliver-all', (_request, response) =>
      void this.deliverAll().then((statuses) => response.json({ statuses })),
    );
    return app;
  }

  private control(response: Response, action: () => void): void {
    try {
      action();
      response.json({ ok: true });
    } catch (error) {
      response.status(409).json({ error: { code: 'invalid_state', message: (error as Error).message } });
    }
  }

  private async handle(operation: MockOperation, request: Request, response: Response, effect: () => StoredWrite): Promise<void> {
    this.requests[operation] += 1;
    const fault = this.faults.get(operation)?.shift();
    const isWrite = operation === 'authorize' || operation === 'capture' || operation === 'void';
    const idempotencyKey = request.header('idempotency-key');
    if (isWrite && !idempotencyKey) {
      response.status(400).json({ error: { code: 'idempotency_key_required' } });
      return;
    }
    const storeKey = `${operation}:${idempotencyKey}`;

    switch (fault) {
      case 'server_error':
        response.status(500).json({ error: { code: 'internal_error' } });
        return;
      case 'rate_limited':
        response.status(429).json({ error: { code: 'rate_limited' } });
        return;
      case 'error_body_200':
        response.status(200).json({ error: { code: 'temporarily_unavailable', message: 'try again' } });
        return;
      case 'malformed_json':
        response.status(200).type('application/json').send('{"id": "pay_');
        return;
      case 'timeout_before_effect':
        await this.hang();
        if (!response.headersSent) response.status(504).json({ error: { code: 'timeout' } });
        return;
      default:
        break;
    }

    let result = isWrite ? this.writes.get(storeKey) : undefined;
    if (!result) {
      result = effect();
      if (isWrite && result.statusCode < 500) this.writes.set(storeKey, result);
    }
    if (fault === 'timeout_after_effect') await this.hang();
    if (response.headersSent || response.writableEnded) return;
    if (fault === 'bad_field' && typeof result.body === 'object' && result.body !== null) {
      // A field we use, broken: an amount as a JSON number.
      const body = result.body as Record<string, unknown>;
      response.status(result.statusCode).json('data' in body ? body : { ...body, amount: Number(body.amount) });
      return;
    }
    response.status(result.statusCode).json(result.body);
  }

  private hang(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, this.options.hangMilliseconds ?? 3000);
      this.timers.add(timer);
    });
  }

  private authorize(request: Request): StoredWrite {
    const body = request.body as Record<string, unknown>;
    const reference = body.reference;
    const amount = body.amount;
    const currency = body.currency;
    const token = body.payment_method_token;
    if (
      typeof reference !== 'string' || typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount) ||
      typeof currency !== 'string' || typeof token !== 'string'
    ) {
      return { statusCode: 400, body: { error: { code: 'invalid_request', message: 'reference, amount, currency, payment_method_token' } } };
    }
    if (this.byReference.has(reference)) {
      return { statusCode: 409, body: { error: { code: 'duplicate_reference' } } };
    }
    const declined = /^tok_decline_([a-z_]+)/.exec(token);
    const payment: MockPayment = {
      id: `pay_${randomBytes(10).toString('hex')}`,
      reference,
      status: declined ? 'declined' : 'authorized',
      amount,
      currency,
      capturedAt: null,
      declineCode: declined ? declined[1] : null,
      chargeback: null,
      createdAt: this.now().toISOString(),
      scenario: token.startsWith('tok_expire') ? 'expire' : token.startsWith('tok_capture_fail') ? 'capture_fail' : 'normal',
      laggingView: null,
      lagReadsLeft: 0,
    };
    this.payments.set(payment.id, payment);
    this.byReference.set(reference, payment.id);
    this.effectiveAuthorizations += 1;
    this.enqueue(`payment.${payment.status}`, this.view(payment));
    return { statusCode: 201, body: this.view(payment) };
  }

  private capture(paymentId: string, request: Request): StoredWrite {
    const payment = this.payments.get(paymentId);
    if (!payment) return { statusCode: 404, body: { error: { code: 'payment_not_found' } } };
    const amount = (request.body as { amount?: unknown }).amount;
    if (amount !== undefined && amount !== payment.amount) {
      return { statusCode: 400, body: { error: { code: 'amount_mismatch' } } };
    }
    if (payment.status !== 'authorized') {
      if (payment.status === 'capture_pending' || payment.status === 'captured') return { statusCode: 200, body: this.view(payment) };
      return { statusCode: 409, body: { error: { code: 'invalid_state', message: payment.status } } };
    }
    if (payment.scenario === 'expire') {
      this.change(payment, { status: 'expired' });
      return { statusCode: 200, body: this.view(payment) };
    }
    if (payment.scenario === 'capture_fail') {
      this.change(payment, { status: 'capture_failed' });
      return { statusCode: 200, body: this.view(payment) };
    }
    this.effectiveCaptures += 1;
    this.change(payment, { status: 'capture_pending' });
    const completion = this.captureCompletion;
    if (completion === 'immediate') {
      this.change(payment, { status: 'captured', capturedAt: this.now().toISOString() });
    } else if (completion !== 'manual') {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (payment.status === 'capture_pending') this.completeCapture(payment.id);
      }, completion.afterMilliseconds);
      this.timers.add(timer);
    }
    return { statusCode: 202, body: this.view(payment) };
  }

  private voidPayment(paymentId: string): StoredWrite {
    const payment = this.payments.get(paymentId);
    if (!payment) return { statusCode: 404, body: { error: { code: 'payment_not_found' } } };
    if (payment.status !== 'authorized') {
      if (payment.status === 'voided') return { statusCode: 200, body: this.view(payment) };
      return { statusCode: 409, body: { error: { code: 'invalid_state', message: payment.status } } };
    }
    this.effectiveVoids += 1;
    this.change(payment, { status: 'voided' });
    return { statusCode: 200, body: this.view(payment) };
  }

  private read(paymentId: string): StoredWrite {
    const payment = this.payments.get(paymentId);
    if (!payment) return { statusCode: 404, body: { error: { code: 'payment_not_found' } } };
    return { statusCode: 200, body: this.lagged(payment) };
  }

  private list(reference: string): StoredWrite {
    const id = this.byReference.get(reference);
    const payment = id ? this.payments.get(id) : undefined;
    return { statusCode: 200, body: { object: 'list', data: payment ? [this.lagged(payment)] : [], has_more: false } };
  }

  // ── state ────────────────────────────────────────────────────────────────

  private require(paymentId: string): MockPayment {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error(`Unknown payment ${paymentId}`);
    return payment;
  }

  private lagged(payment: MockPayment): Record<string, unknown> {
    if (payment.lagReadsLeft > 0 && payment.laggingView) {
      payment.lagReadsLeft -= 1;
      return payment.laggingView;
    }
    return this.view(payment);
  }

  private change(payment: MockPayment, update: Partial<MockPayment>): void {
    if (this.readLag > 0) {
      // Keep showing what reads showed before, for the next `readLag` reads.
      payment.laggingView = payment.lagReadsLeft > 0 && payment.laggingView ? payment.laggingView : this.view(payment);
      payment.lagReadsLeft = this.readLag;
    }
    Object.assign(payment, update);
    this.enqueue(`payment.${payment.status}`, this.view(payment));
  }

  /** The wire shape — with extra fields our adapter must ignore. */
  private view(payment: MockPayment): Record<string, unknown> {
    return {
      id: payment.id,
      object: 'payment',
      reference: payment.reference,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      captured_at: payment.capturedAt,
      decline_code: payment.declineCode,
      chargeback: payment.chargeback,
      created_at: payment.createdAt,
      livemode: false,
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
      metadata: {},
    };
  }

  private enqueue(type: string, object: Record<string, unknown>): MockWebhookEvent {
    this.eventSequence += 1;
    const id = `evt_${String(this.eventSequence).padStart(6, '0')}_${randomBytes(4).toString('hex')}`;
    const body = Buffer.from(JSON.stringify({ id, object: 'event', type, created: this.now().toISOString(), data: { object } }));
    const event = { id, type, paymentId: String(object.id), body };
    this.queue.push(event);
    if (this.options.autoDeliverWebhooks && this.deliverer) {
      void this.deliver(id).catch(() => undefined);
    }
    return event;
  }

  private async send(body: Buffer): Promise<number> {
    if (!this.deliverer) throw new Error('No webhook deliverer configured');
    return this.deliverer(body, { 'content-type': 'application/json', 'x-psp-signature': this.sign(body) });
  }
}

export { OPERATIONS as MOCK_OPERATIONS };
