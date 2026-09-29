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

export type MockOperation = 'authorize' | 'capture' | 'void' | 'get' | 'list';

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
}

interface StoredWrite {
  readonly statusCode: number;
  readonly body: unknown;
}

const OPERATIONS: readonly MockOperation[] = ['authorize', 'capture', 'void', 'get', 'list'];

export class MockPsp {
  private readonly payments = new Map<string, MockPayment>();
  private readonly byReference = new Map<string, string>();
  private readonly writes = new Map<string, StoredWrite>();
  private readonly faults = new Map<MockOperation, FaultKind[]>();
  private readonly queue: MockWebhookEvent[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly requests: Record<MockOperation, number> = { authorize: 0, capture: 0, void: 0, get: 0, list: 0 };
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
    this.change(payment, { status: 'captured', capturedAt: new Date().toISOString() });
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
      chargeback: { id: `cb_${randomBytes(8).toString('hex')}`, amount: amount ?? payment.amount, created_at: new Date().toISOString() },
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
      void this.handle('list', request, response, () => this.list(String(request.query.reference ?? ''))),
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
      createdAt: new Date().toISOString(),
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
      this.change(payment, { status: 'captured', capturedAt: new Date().toISOString() });
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
    const body = Buffer.from(JSON.stringify({ id, object: 'event', type, created: new Date().toISOString(), data: { object } }));
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
