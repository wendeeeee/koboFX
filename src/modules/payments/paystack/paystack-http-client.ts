import { RandomSource } from '../../../common/polling/backoff';
import { ProviderHttpClient, ResponseClassification } from '../../../common/http/provider-http-client';
import { ProviderCallRecorder } from '../../../common/http/provider-call-recorder';
import { parsePaystackJson } from './paystack-responses';

export interface PaystackHttpClientOptions {
  readonly provider: string;
  readonly baseUrl: string;
  readonly secretKey: string;
  readonly timeoutMilliseconds: number;
  readonly initializeTimeoutMilliseconds: number;
  readonly readRetries: number;
  readonly retryBaseMilliseconds?: number;
  readonly retryCapMilliseconds?: number;
  readonly random?: RandomSource;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly fetch?: typeof fetch;
}

export interface PaystackRequest {
  readonly operation: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly flowId?: string;
}

/** Synthesised from Paystack's 4xx MESSAGES (it has no stable codes for these): what the adapter acts on. */
export enum PaystackRefusal {
  /** `400 "Transaction reference not found"` — verify of a reference Paystack never saw (a 404 in its spec; 400 live). */
  REFERENCE_NOT_FOUND = 'reference_not_found',
  /** `400 "Duplicate Transaction Reference"` — initialize with a reference already used. */
  DUPLICATE_REFERENCE = 'duplicate_reference',
}

/** Beyond the shared rule (which already covers email, phone, authorization, card, token…): a customer's identity. */
export const PAYSTACK_EXTRA_REDACTED_KEYS = /^(customer|ip_address|first_name|last_name)$/i;

function messageOf(body: unknown): string {
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : '';
}

function codeOf(body: unknown): string | null {
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code.slice(0, 64) : null;
}

/**
 * How Paystack's answers are read (PAYSTACK_PLAN.md A2, A17):
 * - not JSON → INVALID (retried like transient);
 * - 5xx, 429 → TRANSIENT; a 2xx whose `status` is not `true` → TRANSIENT (a "200 with an error", logged);
 * - `400 "Transaction reference not found"` / a 404 → DEFINITIVE `reference_not_found` (the adapter turns it into null);
 * - `400 "Duplicate Transaction Reference"` → DEFINITIVE `duplicate_reference`;
 * - any other 4xx (a bad key is a 401) → DEFINITIVE with Paystack's `code`, never retried.
 */
export function classifyPaystackResponse(status: number, text: string): ResponseClassification<unknown> {
  let body: unknown;
  try {
    body = text.length === 0 ? null : parsePaystackJson(text);
  } catch {
    return { outcome: 'INVALID', error: 'unparseable JSON' };
  }
  const ok = status >= 200 && status < 300;
  if (status >= 500 || status === 429) return { outcome: 'TRANSIENT', error: `provider error ${status}` };
  if (ok) {
    const flag = typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : undefined;
    if (flag === true) return { outcome: 'OK', value: body };
    return { outcome: 'TRANSIENT', error: 'status is not true', warning: 'Paystack returned 2xx without status:true' };
  }
  const message = messageOf(body).toLowerCase();
  if (status === 404 || (status === 400 && message.includes('reference not found'))) {
    return { outcome: 'DEFINITIVE', error: 'reference not found', providerErrorCode: PaystackRefusal.REFERENCE_NOT_FOUND };
  }
  if (status === 400 && message.includes('duplicate transaction reference')) {
    return { outcome: 'DEFINITIVE', error: 'duplicate reference', providerErrorCode: PaystackRefusal.DUPLICATE_REFERENCE };
  }
  return { outcome: 'DEFINITIVE', error: `rejected ${codeOf(body) ?? status}`, providerErrorCode: codeOf(body) };
}

/**
 * The transport to Paystack: the shared `ProviderHttpClient` (per-attempt timeout, reads retried with full jitter,
 * every attempt recorded) with Paystack's classification. The secret key travels ONLY in the `Authorization` header —
 * headers are never recorded, and the shared client scrubs it from every recorded path, error text and body. Responses
 * are recorded key-redacted with every digit kept. Writes (initialize) are sent once, with their own timeout budget.
 */
export class PaystackHttpClient {
  private readonly reads: ProviderHttpClient;
  private readonly writes: ProviderHttpClient;

  constructor(
    private readonly options: PaystackHttpClientOptions,
    recorder: ProviderCallRecorder,
  ) {
    const shared = {
      provider: options.provider,
      label: 'Paystack',
      baseUrl: options.baseUrl,
      readRetries: options.readRetries,
      retryBaseMilliseconds: options.retryBaseMilliseconds,
      retryCapMilliseconds: options.retryCapMilliseconds,
      secrets: [options.secretKey],
      recordResponseAs: 'redacted-lossless-json' as const,
      extraRedactedKeys: PAYSTACK_EXTRA_REDACTED_KEYS,
      random: options.random,
      sleep: options.sleep,
      fetch: options.fetch,
    };
    this.reads = new ProviderHttpClient({ ...shared, timeoutMilliseconds: options.timeoutMilliseconds }, recorder);
    this.writes = new ProviderHttpClient({ ...shared, timeoutMilliseconds: options.initializeTimeoutMilliseconds }, recorder);
  }

  async send(request: PaystackRequest): Promise<unknown> {
    const write = request.method === 'POST';
    const response = await (write ? this.writes : this.reads).send({
      operation: request.operation,
      method: request.method,
      path: request.path,
      body: request.body,
      flowId: request.flowId,
      // Paystack has no idempotency key: a re-sent write could create a second transaction.
      retryable: !write,
      headers: { Authorization: `Bearer ${this.options.secretKey}` },
      classify: classifyPaystackResponse,
    });
    return response.value;
  }
}
