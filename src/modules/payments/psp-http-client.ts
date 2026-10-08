import { RandomSource } from '../../common/polling/backoff';
import { ProviderHttpClient, ResponseClassification } from '../../common/http/provider-http-client';
import { ProviderCallRecorder } from '../../common/http/provider-call-recorder';
import { providerErrorCode } from './psp-responses';

export interface PspHttpClientOptions {
  readonly provider: string;
  readonly baseUrl: string;
  readonly secretKey: string;
  readonly timeoutMilliseconds: number;
  readonly readRetries: number;
  readonly retryBaseMilliseconds?: number;
  readonly retryCapMilliseconds?: number;
  readonly random?: RandomSource;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly fetch?: typeof fetch;
}

export interface PspRequest {
  readonly operation: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly flowId?: string;
  readonly recordRawResponse?: boolean;
}

export interface PspResponse {
  readonly status: number;
  readonly body: unknown;
  readonly providerCallId: string | undefined;
}

export function isRetryable(method: PspRequest['method']): boolean {
  return method === 'GET';
}


export function classifyPspResponse(status: number, text: string): ResponseClassification<unknown> {
  let body: unknown;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    return { outcome: 'INVALID', error: 'unparseable JSON' };
  }
  const errorCode = providerErrorCode(body);
  const ok = status >= 200 && status < 300;
  if (status >= 500 || status === 429 || (ok && errorCode !== undefined)) {
    return {
      outcome: 'TRANSIENT',
      error: `provider error ${errorCode ?? status}`,
      ...(ok ? { warning: 'PSP returned 200 with an error body' } : {}),
    };
  }
  if (!ok) return { outcome: 'DEFINITIVE', error: `rejected ${errorCode ?? ''}`.trim(), providerErrorCode: errorCode ?? null };
  return { outcome: 'OK', value: body };
}


export class PspHttpClient {
  private readonly client: ProviderHttpClient;

  constructor(
    private readonly options: PspHttpClientOptions,
    recorder: ProviderCallRecorder,
  ) {
    this.client = new ProviderHttpClient(
      {
        provider: options.provider,
        label: 'PSP',
        baseUrl: options.baseUrl,
        timeoutMilliseconds: options.timeoutMilliseconds,
        readRetries: options.readRetries,
        retryBaseMilliseconds: options.retryBaseMilliseconds,
        retryCapMilliseconds: options.retryCapMilliseconds,
        secrets: [options.secretKey],
        recordResponseAs: 'redacted-json',
        random: options.random,
        sleep: options.sleep,
        fetch: options.fetch,
      },
      recorder,
    );
  }

  async send(request: PspRequest): Promise<PspResponse> {
    if (request.method === 'POST' && !request.idempotencyKey) {
      throw new Error(`PSP write ${request.operation} sent without an idempotency key`);
    }
    const response = await this.client.send({
      operation: request.operation,
      method: request.method,
      path: request.path,
      body: request.body,
      flowId: request.flowId,
      retryable: isRetryable(request.method),
      headers: {
        Authorization: `Bearer ${this.options.secretKey}`,
        ...(request.idempotencyKey ? { 'Idempotency-Key': request.idempotencyKey } : {}),
      },
      classify: classifyPspResponse,
      ...(request.recordRawResponse ? { recordResponseAs: 'raw-json-text' as const } : {}),
    });
    return { status: response.status, body: response.value, providerCallId: response.providerCallId };
  }
}
