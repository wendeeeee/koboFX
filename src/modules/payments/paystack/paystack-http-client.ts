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


export enum PaystackRefusal {
  REFERENCE_NOT_FOUND = 'reference_not_found',
  DUPLICATE_REFERENCE = 'duplicate_reference',
}


export const PAYSTACK_EXTRA_REDACTED_KEYS = /^(customer|ip_address|first_name|last_name)$/i;

function messageOf(body: unknown): string {
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : '';
}

function codeOf(body: unknown): string | null {
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code.slice(0, 64) : null;
}


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
      retryable: !write,
      headers: { Authorization: `Bearer ${this.options.secretKey}` },
      classify: classifyPaystackResponse,
    });
    return response.value;
  }
}
