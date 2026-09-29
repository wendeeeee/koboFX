import { Logger } from '@nestjs/common';
import { RandomSource, fullJitterDelayMilliseconds } from '../../common/polling/backoff';
import { ProviderRequestRejectedError, ProviderResponseInvalidError, ProviderUnavailableError } from './payment.errors';
import { ProviderCallDirection, ProviderCallRecorder, unparsedBody } from './provider-call-recorder';
import { providerErrorCode } from './psp-responses';

export interface PspHttpClientOptions {
  readonly provider: string;
  readonly baseUrl: string;
  readonly secretKey: string;
  /** Per attempt (design §7.2: 2s). */
  readonly timeoutMilliseconds: number;
  /** Retries after the first attempt, idempotent reads only (design §7.2: 3). */
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
  /** Required on every POST: the PSP deduplicates writes on it. */
  readonly idempotencyKey?: string;
  readonly flowId?: string;
}

export interface PspResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Only a read may be retried: re-sending a write could double its effect (design §7.2). */
export function isRetryable(method: PspRequest['method']): boolean {
  return method === 'GET';
}

/**
 * The transport to the PSP (design §7.2, handbook: consuming APIs):
 *
 * - a per-attempt timeout (`AbortSignal.timeout`);
 * - bounded retries with exponential backoff and full jitter — for GETs only;
 * - a `200` carrying an error body is an error, not a success;
 * - every attempt, success or failure, is one `provider_calls` row;
 * - the API key travels in a header and is never recorded (headers are not stored).
 *
 * Classification: timeout, network error, 5xx, 429, error body or unparseable JSON →
 * `ProviderUnavailableError` (transient; for a write the outcome is unknown); any other
 * 4xx → `ProviderRequestRejectedError` (definitive).
 */
export class PspHttpClient {
  private readonly logger = new Logger(PspHttpClient.name);
  private readonly random: RandomSource;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly fetch: typeof fetch;

  constructor(
    private readonly options: PspHttpClientOptions,
    private readonly recorder: ProviderCallRecorder,
  ) {
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.fetch = options.fetch ?? fetch;
  }

  async send(request: PspRequest): Promise<PspResponse> {
    if (request.method === 'POST' && !request.idempotencyKey) {
      throw new Error(`PSP write ${request.operation} sent without an idempotency key`);
    }
    const attempts = isRetryable(request.method) ? 1 + this.options.readRetries : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.attempt(request, attempt);
      } catch (error) {
        lastError = error;
        if (error instanceof ProviderRequestRejectedError || attempt === attempts) break;
        await this.sleep(
          fullJitterDelayMilliseconds(
            attempt - 1,
            this.options.retryBaseMilliseconds ?? 100,
            this.options.retryCapMilliseconds ?? 2000,
            this.random,
          ),
        );
      }
    }
    throw lastError;
  }

  private async attempt(request: PspRequest, attempt: number): Promise<PspResponse> {
    const started = Date.now();
    const record = (fields: { responseStatus?: number; responseBody?: unknown; error?: string }) =>
      this.recorder.recordQuietly({
        provider: this.options.provider,
        operation: request.operation,
        direction: ProviderCallDirection.OUTBOUND,
        flowId: request.flowId,
        requestMethod: request.method,
        requestPath: request.path,
        attempt,
        requestBody: request.body,
        durationMilliseconds: Date.now() - started,
        ...fields,
      });

    let response: Response;
    let text: string;
    try {
      response = await this.fetch(new URL(request.path, this.options.baseUrl), {
        method: request.method,
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          Accept: 'application/json',
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
          ...(request.idempotencyKey ? { 'Idempotency-Key': request.idempotencyKey } : {}),
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMilliseconds),
      });
      text = await response.text();
    } catch (error) {
      // `AbortSignal.timeout` rejects with a DOMException named TimeoutError (not always `instanceof Error`).
      const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
      const reason = name === 'TimeoutError' ? 'timed out' : 'network error';
      await record({ error: `${reason}: ${typeof message === 'string' ? message : String(error)}` });
      throw new ProviderUnavailableError(`PSP ${request.operation} ${reason}`, request.operation);
    }

    let body: unknown;
    try {
      body = text.length === 0 ? null : JSON.parse(text);
    } catch {
      await record({ responseStatus: response.status, responseBody: unparsedBody(text), error: 'unparseable JSON' });
      throw new ProviderResponseInvalidError(`PSP ${request.operation} returned a body that is not JSON`, request.operation);
    }

    const errorCode = providerErrorCode(body);
    if (response.status >= 500 || response.status === 429 || (response.ok && errorCode !== undefined)) {
      await record({ responseStatus: response.status, responseBody: body, error: `provider error ${errorCode ?? response.status}` });
      if (response.ok) this.logger.warn({ operation: request.operation, errorCode }, 'PSP returned 200 with an error body');
      throw new ProviderUnavailableError(`PSP ${request.operation} failed (${response.status})`, request.operation, response.status);
    }
    if (!response.ok) {
      await record({ responseStatus: response.status, responseBody: body, error: `rejected ${errorCode ?? ''}`.trim() });
      throw new ProviderRequestRejectedError(
        `PSP rejected ${request.operation} (${response.status})`,
        request.operation,
        response.status,
        errorCode ?? null,
      );
    }
    await record({ responseStatus: response.status, responseBody: body });
    return { status: response.status, body };
  }
}
