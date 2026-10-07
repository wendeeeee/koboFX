import type { Express, Request, Response } from 'express';
import { isLosslessNumber, LosslessNumber, parse, stringify } from 'lossless-json';

/**
 * The transfer side of the simulated Paystack (WITHDRAWAL_PLAN.md §B; W2), with the documented shapes (checked
 * 2026-10-02): `/bank` (cursor pages), `/bank/resolve`, `/transferrecipient` (a duplicate account number returns the
 * EXISTING recipient), `/transfer` (`source: balance`, integer subunits, our reference; principal AND fee deducted at
 * creation; a reused reference is refused; `transferred_at: null` even on success, as in test mode), `/transfer/verify/
 * :reference`, `/transfer/:id_or_code`, `/balance`, `/balance/ledger`. Ids are JSON numbers beyond 2^53.
 *
 * Scripting: accounts that resolve, balance, the next transfer's status and fee (or a null fee), status changes
 * (success / failed / reversed — a reversal returns the principal), verify lag, foreign transfers, transfer webhooks.
 * Mocks never invent what Paystack does not document: no returned amount, no reversal time, no event id.
 */
export type MockTransferStatus = 'pending' | 'otp' | 'received' | 'success' | 'failed' | 'abandoned' | 'blocked' | 'rejected' | 'reversed';

export const MOCK_TRANSFER_OPERATIONS = [
  'bank_list',
  'bank_resolve',
  'recipient_create',
  'recipient_list',
  'recipient_fetch',
  'transfer_initiate',
  'transfer_verify',
  'transfer_fetch',
  'transfer_list',
  'balance',
  'balance_ledger',
] as const;
export type MockTransferOperation = (typeof MOCK_TRANSFER_OPERATIONS)[number];

interface MockAccount {
  bankCode: string;
  accountNumber: string;
  accountName: string | null;
}

interface MockRecipient {
  id: string;
  code: string;
  name: string;
  bankCode: string;
  accountNumber: string;
  accountName: string | null;
  currency: string;
  createdAt: string;
  active: boolean;
  isDeleted: boolean;
}

export interface MockTransfer {
  id: string;
  code: string;
  reference: string;
  amount: bigint;
  currency: string;
  recipientId: string;
  reason: string;
  status: MockTransferStatus;
  fee: bigint | null;
  domain: string;
  createdAt: string;
  updatedAt: string;
  hiddenVerifies: number;
  returned: boolean;
}

interface LedgerRow {
  id: string;
  difference: bigint;
  balance: bigint;
  reason: string;
  modelResponsible: string;
  modelRow: string;
  createdAt: string;
}

export interface MockTransfersDependencies {
  readonly now: () => Date;
  readonly integrationId: string;
  readonly emit: (event: string, data: Record<string, unknown>) => void;
  readonly handle: (operation: MockTransferOperation, response: Response, effect: (into: Response) => unknown) => Promise<void>;
}

const BANKS = [
  { id: 1, name: 'Access Bank', code: '044' },
  { id: 2, name: 'Guaranty Trust Bank', code: '058' },
  { id: 3, name: 'First Bank of Nigeria', code: '011' },
  { id: 4, name: 'United Bank For Africa', code: '033' },
  { id: 5, name: 'Zenith Bank', code: '057' },
];

const FIRST_TRANSFER_ID = 9_007_199_254_741_993n;

export class MockPaystackTransfers {
  private readonly accounts: MockAccount[] = [];
  private readonly recipients: MockRecipient[] = [];
  private readonly transfers = new Map<string, MockTransfer>();
  private readonly ledger: LedgerRow[] = [];
  private balance = 0n;
  private nextTransferId = FIRST_TRANSFER_ID;
  private nextRecipientId = 6_788_170;
  private nextLedgerId = 9_007_199_254_750_000n;
  private nextStatus: MockTransferStatus = 'success';
  private nextFee: bigint | null = 1_000n;
  private nextDomain = 'test';
  private bankPageSize: number | undefined;
  private listPageSize: number | undefined;
  private created = 0;

  constructor(private readonly dependencies: MockTransfersDependencies) {}

  register(app: Express): void {
    const handle = this.dependencies.handle;
    app.get('/bank', (request, response) => void handle('bank_list', response, (into) => this.listBanks(request, into)));
    app.get('/bank/resolve', (request, response) => void handle('bank_resolve', response, (into) => this.resolve(request, into)));
    app.post('/transferrecipient', (request, response) => void handle('recipient_create', response, (into) => this.createRecipient(request, into)));
    app.get('/transferrecipient', (request, response) => void handle('recipient_list', response, (into) => this.listRecipients(request, into)));
    app.get('/transferrecipient/:idOrCode', (request, response) => void handle('recipient_fetch', response, (into) => this.fetchRecipient(request, into)));
    app.post('/transfer', (request, response) => void handle('transfer_initiate', response, (into) => this.initiate(request, into)));
    app.get('/transfer/verify/:reference', (request, response) => void handle('transfer_verify', response, (into) => this.verify(request, into)));
    app.get('/transfer', (request, response) => void handle('transfer_list', response, (into) => this.listTransfers(request, into)));
    app.get('/transfer/:idOrCode', (request, response) => void handle('transfer_fetch', response, (into) => this.fetchTransfer(request, into)));
    app.get('/balance/ledger', (request, response) => void handle('balance_ledger', response, (into) => this.listLedger(request, into)));
    app.get('/balance', (_request, response) => void handle('balance', response, (into) => this.balances(into)));
  }

  // ── scripting ─────────────────────────────────────────────────────────────

  /** An account `/bank/resolve` knows. `accountName: null` scripts Paystack's nullable name. */
  addAccount(bankCode: string, accountNumber: string, accountName: string | null): void {
    this.accounts.push({ bankCode, accountNumber, accountName });
  }

  setBalance(minor: bigint): void {
    this.balance = minor;
  }

  currentBalance(): bigint {
    return this.balance;
  }

  /** The status, fee (null = Paystack sends no fee) and domain the NEXT created transfer gets. */
  setNextTransfer(script: { status?: MockTransferStatus; fee?: bigint | null; domain?: string }): void {
    if (script.status) this.nextStatus = script.status;
    if (script.fee !== undefined) this.nextFee = script.fee;
    if (script.domain) this.nextDomain = script.domain;
  }

  setBankPageSize(size: number | undefined): void {
    this.bankPageSize = size;
  }

  /** Overrides the requested `perPage` of `/transfer` and `/balance/ledger` lists (undefined = honour the request). */
  setListPageSize(size: number | undefined): void {
    this.listPageSize = size;
  }

  /** Move a transfer; `reversed` / `failed` / … after creation return the principal (never the fee — not documented). */
  setTransferStatus(reference: string, status: MockTransferStatus, options: { emit?: boolean } = {}): void {
    const transfer = this.require(reference);
    transfer.status = status;
    transfer.updatedAt = this.dependencies.now().toISOString();
    if (['reversed', 'failed', 'abandoned', 'blocked', 'rejected'].includes(status) && !transfer.returned) {
      transfer.returned = true;
      this.post(transfer.amount, `Transfer ${status}`, 'Transfer', transfer.id);
    }
    if (options.emit && ['success', 'failed', 'reversed'].includes(status)) this.emitTransfer(transfer);
  }

  /** Verify answers 404 for the next `reads` reads (the reference not yet visible). */
  hideTransferFromVerify(reference: string, reads: number): void {
    this.require(reference).hiddenVerifies = reads;
  }

  /** A transfer nobody initiated through us (another app on the account): for unknown-transfer detection. */
  createForeignTransfer(input: { reference: string; amount: bigint; bankCode: string; accountNumber: string; status?: MockTransferStatus }): string {
    const recipient = this.recipientFor(input.bankCode, input.accountNumber, 'Someone Else', 'NGN');
    const transfer = this.createTransfer(input.reference, input.amount, 'NGN', recipient.id, 'foreign', input.status ?? 'success');
    return transfer.code;
  }

  emitTransfer(transfer: MockTransfer): void {
    const event = transfer.status === 'success' ? 'transfer.success' : transfer.status === 'reversed' ? 'transfer.reversed' : 'transfer.failed';
    this.dependencies.emit(event, this.transferData(transfer));
  }

  /** The webhook body Paystack would send for a transfer event (to replay or tamper with). */
  transferEventData(reference: string): Record<string, unknown> {
    return this.transferData(this.require(reference));
  }

  find(reference: string): Readonly<MockTransfer> | undefined {
    return this.transfers.get(reference);
  }

  transfersFor(reference: string): number {
    return [...this.transfers.values()].filter((transfer) => transfer.reference === reference).length;
  }

  recipientCount(): number {
    return this.recipients.length;
  }

  effectiveTransfers(): number {
    return this.created;
  }

  // ── handlers ──────────────────────────────────────────────────────────────

  private listBanks(request: Request, response: Response): void {
    const query = request.query as Record<string, string | undefined>;
    if (query.currency && query.currency !== 'NGN') return this.envelope(response, 200, 'Banks retrieved', [], { next: null, previous: null, perPage: 0 });
    const perPage = this.bankPageSize ?? Math.min(100, Math.max(1, Number.parseInt(query.perPage ?? '50', 10) || 50));
    const start = query.next ? Number.parseInt(Buffer.from(query.next, 'base64url').toString('utf8').replace('bank:', ''), 10) : 0;
    const slice = BANKS.slice(start, start + perPage).map((bank) => ({
      name: bank.name,
      slug: bank.name.toLowerCase().replace(/\s+/g, '-'),
      code: bank.code,
      longcode: '',
      gateway: null,
      pay_with_bank: false,
      active: true,
      is_deleted: false,
      country: 'Nigeria',
      currency: 'NGN',
      type: 'nuban',
      id: bank.id,
      createdAt: '2016-07-14T10:04:29.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    const end = start + slice.length;
    const next = end < BANKS.length ? Buffer.from(`bank:${end}`, 'utf8').toString('base64url') : null;
    this.envelope(response, 200, 'Banks retrieved', slice, { next, previous: null, perPage });
  }

  private resolve(request: Request, response: Response): void {
    const query = request.query as Record<string, string | undefined>;
    const account = this.accounts.find((each) => each.bankCode === query.bank_code && each.accountNumber === query.account_number);
    if (!account) {
      this.error(response, 422, 'Could not resolve account name. Check parameters or try again.');
      return;
    }
    this.envelope(response, 200, 'Account number resolved', {
      account_number: account.accountNumber,
      account_name: account.accountName,
      bank_id: BANKS.find((bank) => bank.code === account.bankCode)?.id ?? 0,
    });
  }

  private createRecipient(request: Request, response: Response): void {
    const body = this.body(request);
    if (body.type !== 'nuban' || typeof body.account_number !== 'string' || typeof body.bank_code !== 'string' || typeof body.name !== 'string') {
      this.error(response, 400, 'Invalid recipient');
      return;
    }
    if (!this.accounts.some((each) => each.bankCode === body.bank_code && each.accountNumber === body.account_number)) {
      this.error(response, 400, 'Account number is invalid');
      return;
    }
    const recipient = this.recipientFor(body.bank_code, body.account_number, body.name, typeof body.currency === 'string' ? body.currency : 'NGN');
    this.envelope(response, 201, 'Transfer recipient created successfully', this.recipientData(recipient));
  }

  private listRecipients(request: Request, response: Response): void {
    this.page(response, request, this.recipients.map((recipient) => this.recipientData(recipient)));
  }

  private fetchRecipient(request: Request, response: Response): void {
    const key = String(request.params.idOrCode);
    const recipient = this.recipients.find((each) => each.id === key || each.code === key);
    if (!recipient) return this.error(response, 404, 'Recipient not found');
    this.envelope(response, 200, 'Recipient retrieved', this.recipientData(recipient));
  }

  private initiate(request: Request, response: Response): void {
    const body = this.body(request);
    const amount = isLosslessNumber(body.amount) && /^[1-9]\d{0,18}$/.test(body.amount.value) ? BigInt(body.amount.value) : null;
    if (body.source !== 'balance' || amount === null || typeof body.reference !== 'string' || typeof body.recipient !== 'string') {
      this.error(response, 400, 'Invalid transfer request: amount must be an integer in subunits');
      return;
    }
    if (!/^[a-z0-9_-]{16,50}$/.test(body.reference)) return this.error(response, 400, 'Invalid reference');
    if (this.transfers.has(body.reference)) return this.error(response, 400, 'Duplicate Transfer Reference');
    const recipient = this.recipients.find((each) => each.code === body.recipient);
    if (!recipient) return this.error(response, 400, 'Recipient not found');
    const fee = this.nextFee ?? 0n;
    if (this.balance < amount + fee) return this.error(response, 400, 'Your balance is not enough to fulfil this request');
    const transfer = this.createTransfer(body.reference, amount, typeof body.currency === 'string' ? body.currency : 'NGN', recipient.id, String(body.reason ?? ''), this.nextStatus);
    this.envelope(response, 200, transfer.status === 'otp' ? 'Transfer requires OTP to continue' : 'Transfer has been queued', {
      ...this.transferCore(transfer),
      recipient: new LosslessNumber(transfer.recipientId),
      transfersessionid: [],
      source_details: null,
      failures: null,
      titan_code: null,
    });
  }

  private verify(request: Request, response: Response): void {
    const transfer = this.transfers.get(String(request.params.reference));
    if (!transfer || transfer.hiddenVerifies > 0) {
      if (transfer) transfer.hiddenVerifies -= 1;
      return this.error(response, 404, 'Transfer not found');
    }
    this.envelope(response, 200, 'Transfer retrieved', this.transferData(transfer));
  }

  private fetchTransfer(request: Request, response: Response): void {
    const key = String(request.params.idOrCode);
    const transfer = [...this.transfers.values()].find((each) => each.id === key || each.code === key);
    if (!transfer) return this.error(response, 404, 'Transfer not found');
    this.envelope(response, 200, 'Transfer retrieved', this.transferData(transfer));
  }

  private listTransfers(request: Request, response: Response): void {
    const { from, to } = this.range(request);
    const items = [...this.transfers.values()].filter((transfer) => transfer.createdAt >= from && transfer.createdAt < to);
    this.page(response, request, items.map((transfer) => this.transferData(transfer)));
  }

  private balances(response: Response): void {
    this.envelope(response, 200, 'Balances retrieved', [{ currency: 'NGN', balance: new LosslessNumber(this.balance.toString()) }]);
  }

  private listLedger(request: Request, response: Response): void {
    const { from, to } = this.range(request);
    const items = this.ledger
      .filter((row) => row.createdAt >= from && row.createdAt < to)
      .map((row) => ({
        integration: new LosslessNumber(this.dependencies.integrationId),
        domain: 'test',
        balance: new LosslessNumber(row.balance.toString()),
        currency: 'NGN',
        difference: new LosslessNumber(row.difference.toString()),
        reason: row.reason,
        model_responsible: row.modelResponsible,
        model_row: new LosslessNumber(row.modelRow),
        id: new LosslessNumber(row.id),
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      }));
    this.page(response, request, items);
  }

  // ── state ─────────────────────────────────────────────────────────────────

  private recipientFor(bankCode: string, accountNumber: string, name: string, currency: string): MockRecipient {
    const existing = this.recipients.find((each) => each.bankCode === bankCode && each.accountNumber === accountNumber);
    if (existing) return existing;
    const account = this.accounts.find((each) => each.bankCode === bankCode && each.accountNumber === accountNumber);
    const id = String((this.nextRecipientId += 1));
    const recipient: MockRecipient = {
      id,
      code: `RCP_${id}mock`,
      name,
      bankCode,
      accountNumber,
      accountName: account?.accountName ?? null,
      currency,
      createdAt: this.dependencies.now().toISOString(),
      active: true,
      isDeleted: false,
    };
    this.recipients.push(recipient);
    return recipient;
  }

  private createTransfer(reference: string, amount: bigint, currency: string, recipientId: string, reason: string, status: MockTransferStatus): MockTransfer {
    const id = (this.nextTransferId += 1n).toString();
    const at = this.dependencies.now().toISOString();
    const transfer: MockTransfer = {
      id,
      code: `TRF_${id}mock`,
      reference,
      amount,
      currency,
      recipientId,
      reason,
      status,
      fee: this.nextFee,
      domain: this.nextDomain,
      createdAt: at,
      updatedAt: at,
      hiddenVerifies: 0,
      returned: false,
    };
    this.transfers.set(reference, transfer);
    this.created += 1;
    this.post(-amount, 'Transfer', 'Transfer', id);
    if (transfer.fee !== null && transfer.fee > 0n) this.post(-transfer.fee, 'Transfer fee', 'Transfer', id);
    return transfer;
  }

  private post(difference: bigint, reason: string, modelResponsible: string, modelRow: string): void {
    this.balance += difference;
    this.ledger.push({
      id: (this.nextLedgerId += 1n).toString(),
      difference,
      balance: this.balance,
      reason,
      modelResponsible,
      modelRow,
      createdAt: this.dependencies.now().toISOString(),
    });
  }

  private require(reference: string): MockTransfer {
    const transfer = this.transfers.get(reference);
    if (!transfer) throw new Error(`mock Paystack: no transfer ${reference}`);
    return transfer;
  }

  private transferCore(transfer: MockTransfer): Record<string, unknown> {
    return {
      amount: new LosslessNumber(transfer.amount.toString()),
      currency: transfer.currency,
      domain: transfer.domain,
      id: new LosslessNumber(transfer.id),
      integration: new LosslessNumber(this.dependencies.integrationId),
      reason: transfer.reason,
      reference: transfer.reference,
      source: 'balance',
      status: transfer.status,
      transfer_code: transfer.code,
      transferred_at: null,
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
    };
  }

  private transferData(transfer: MockTransfer): Record<string, unknown> {
    const recipient = this.recipients.find((each) => each.id === transfer.recipientId) as MockRecipient;
    return {
      ...this.transferCore(transfer),
      recipient: this.recipientData(recipient),
      session: { provider: null, id: null },
      fee_charged: transfer.fee === null ? undefined : new LosslessNumber(transfer.fee.toString()),
      fees_breakdown: null,
      failures: null,
      titan_code: null,
    };
  }

  private recipientData(recipient: MockRecipient): Record<string, unknown> {
    return {
      active: recipient.active,
      createdAt: recipient.createdAt,
      currency: recipient.currency,
      description: null,
      domain: 'test',
      email: null,
      id: new LosslessNumber(recipient.id),
      integration: new LosslessNumber(this.dependencies.integrationId),
      metadata: null,
      name: recipient.name,
      recipient_code: recipient.code,
      type: 'nuban',
      updatedAt: recipient.createdAt,
      is_deleted: recipient.isDeleted,
      details: {
        authorization_code: null,
        account_number: recipient.accountNumber,
        account_name: recipient.accountName,
        bank_code: recipient.bankCode,
        bank_name: BANKS.find((bank) => bank.code === recipient.bankCode)?.name ?? null,
      },
    };
  }

  private body(request: Request): Record<string, unknown> {
    const raw = (request as Request & { rawBody?: string }).rawBody;
    try {
      const parsed = raw ? parse(raw) : {};
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private range(request: Request): { from: string; to: string } {
    const query = request.query as Record<string, string | undefined>;
    return {
      from: query.from ? new Date(query.from).toISOString() : '0000-01-01T00:00:00.000Z',
      to: query.to ? new Date(query.to).toISOString() : '9999-12-31T23:59:59.999Z',
    };
  }

  private page(response: Response, request: Request, items: unknown[]): void {
    const query = request.query as Record<string, string | undefined>;
    const perPage = this.listPageSize ?? Math.max(1, Number.parseInt(query.perPage ?? '50', 10) || 50);
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const pageCount = Math.max(1, Math.ceil(items.length / perPage));
    this.envelope(response, 200, 'Retrieved', items.slice((page - 1) * perPage, page * perPage), {
      total: items.length,
      skipped: (page - 1) * perPage,
      perPage,
      page,
      pageCount,
    });
  }

  private envelope(response: Response, status: number, message: string, data: unknown, meta?: Record<string, unknown>): void {
    response
      .status(status)
      .type('application/json')
      .send(stringify({ status: true, message, data, ...(meta ? { meta } : {}) }) ?? '');
  }

  private error(response: Response, status: number, message: string): void {
    response.status(status).type('application/json').send(JSON.stringify({ status: false, message }));
  }
}
