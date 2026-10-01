import { Logger } from '@nestjs/common';
import { RandomSource, fullJitterDelayMilliseconds } from '../polling/backoff';
import { ProviderCallDirection, ProviderCallRecorder, unparsedBody } from './provider-call-recorder';
import { ProviderRequestRejectedError, ProviderResponseInvalidError, ProviderUnavailableError } from './provider.errors';
import { REDACTED, redactJsonTextLosslessly } from './redaction';

/**
 * What a provider's response means, decided by the adapter that knows the provider
 * (handbook: "HTTP codes that don't mean what they should"):
 * - `OK` — a usable answer, with the adapter's parsed `value`;
 * - `TRANSIENT` — no usable answer this time (5xx, 429, a `200` carrying an error body…);
 *   retried when the request is retryable → `ProviderUnavailableError`;
 * - `INVALID` — an answer we cannot read (not JSON, a field we use malformed); retried
 *   like a transient failure → `ProviderResponseInvalidError`;
 * - `DEFINITIVE` — the provider refused and will refuse again (a 4xx, a revoked key, a
 *   spent quota); never retried → `ProviderRequestRejectedError`.
 */
export type ResponseClassification<T> =
  | { readonly outcome: 'OK'; readonly value: T }
  | { readonly outcome: 'TRANSIENT'; readonly error: string; readonly warning?: string }
  | { readonly outcome: 'INVALID'; readonly error: string }
  | { readonly outcome: 'DEFINITIVE'; readonly error: string; readonly providerErrorCode: string | null };

export type ResponseClassifier<T> = (status: number, text: string) => ResponseClassification<T>;

export type RecordResponseAs = 'redacted-json' | 'raw-json-text' | 'redacted-lossless-json';

export interface ProviderHttpClientOptions {
  /** Name recorded on every `provider_calls` row. */
  readonly provider: string;
  /** How errors name the provider ("PSP", "ExchangeRate-API"). Never a URL. */
  readonly label: string;
  readonly baseUrl: string;
  /** Per attempt (design §7.2: 2s). */
  readonly timeoutMilliseconds: number;
  /** Retries after the first attempt, retryable (idempotent) requests only (design §7.2: 3). */
  readonly readRetries: number;
  readonly retryBaseMilliseconds?: number;
  readonly retryCapMilliseconds?: number;
  /**
   * Credentials that must never reach `provider_calls`, a log or an error message —
   * scrubbed from every recorded path, error text and raw body (defence in depth: the
   * adapter already keeps them out of `recordedPath`).
   */
  readonly secrets?: readonly string[];
  /**
   * How response bodies are recorded: parsed and key-redacted (`redacted-json`, for bodies
   * that may carry sensitive fields), or the raw text as JSONB (`raw-json-text`, for bodies
   * that carry none and whose numbers must keep every digit — a rate feed), or both
   * (`redacted-lossless-json`: key-redacted AND every digit kept — a provider sending money as JSON numbers).
   */
  readonly recordResponseAs?: RecordResponseAs;
  /** With `redacted-lossless-json`: keys redacted beyond the shared rule (e.g. a customer object). */
  readonly extraRedactedKeys?: RegExp;
  readonly random?: RandomSource;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly fetch?: typeof fetch;
}

export interface ProviderHttpRequest<T> {
  readonly operation: string;
  readonly method: 'GET' | 'POST';
  /** The real path — may carry a credential (e.g. an API key in the URL). Never recorded. */
  readonly path: string;
  /** What `provider_calls` and logs see instead of `path`. Defaults to `path`, scrubbed. */
  readonly recordedPath?: string;
  readonly headers?: Record<string, string>;
  readonly body?: Record<string, unknown>;
  readonly flowId?: string;
  /** Only an idempotent read may be retried (design §7.2). Defaults to `method === 'GET'`. */
  readonly retryable?: boolean;
  /** Overrides the client's retries for this request (e.g. a single attempt on a latency budget). */
  readonly maximumAttempts?: number;
  /**
   * Runs before every attempt, retries included; throwing stops the request with that
   * error and nothing is sent (e.g. a provider request budget that is spent).
   */
  readonly beforeAttempt?: (attempt: number) => Promise<void>;
  readonly classify: ResponseClassifier<T>;
  /** Overrides the client's `recordResponseAs` for this request (e.g. a settlement report's raw text). */
  readonly recordResponseAs?: RecordResponseAs;
}

export interface ProviderHttpResponse<T> {
  readonly status: number;
  readonly value: T;
  /** The `provider_calls` row of the successful attempt, when it could be written. */
  readonly providerCallId: string | undefined;
}

/**
 * The one transport to third-party APIs (design §7.2, handbook: consuming APIs), shared
 * by every adapter (the PSP, the FX rate provider):
 *
 * - a per-attempt timeout (`AbortSignal.timeout`);
 * - bounded retries with exponential backoff and full jitter — retryable requests only;
 * - the adapter classifies each response (a `200` may carry an error; a `403` may be the
 *   only sign of a revoked key);
 * - every attempt, success or failure, is one `provider_calls` row, recorded on the pool
 *   (never inside a transaction — and no transaction is ever held across the call);
 * - credentials never reach a recorded path, an error text or a log line.
 */
export class ProviderHttpClient {
  private readonly logger = new Logger(ProviderHttpClient.name);
  private readonly random: RandomSource;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly fetch: typeof fetch;

  constructor(
    private readonly options: ProviderHttpClientOptions,
    private readonly recorder: ProviderCallRecorder,
  ) {
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.fetch = options.fetch ?? fetch;
  }

  /** Replace every configured secret in `text` with `[REDACTED]`. */
  scrub(text: string): string {
    let result = text;
    for (const secret of this.options.secrets ?? []) {
      if (secret.length > 0) result = result.split(secret).join(REDACTED);
    }
    return result;
  }

  async send<T>(request: ProviderHttpRequest<T>): Promise<ProviderHttpResponse<T>> {
    const retryable = request.retryable ?? request.method === 'GET';
    const attempts = request.maximumAttempts ?? (retryable ? 1 + this.options.readRetries : 1);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await request.beforeAttempt?.(attempt);
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

  private async attempt<T>(request: ProviderHttpRequest<T>, attempt: number): Promise<ProviderHttpResponse<T>> {
    const { label } = this.options;
    const started = Date.now();
    const record = (fields: { responseStatus?: number; responseText?: string; error?: string }) =>
      this.recorder.recordQuietly({
        provider: this.options.provider,
        operation: request.operation,
        direction: ProviderCallDirection.OUTBOUND,
        flowId: request.flowId,
        requestMethod: request.method,
        requestPath: this.scrub(request.recordedPath ?? request.path),
        attempt,
        requestBody: request.body,
        durationMilliseconds: Date.now() - started,
        responseStatus: fields.responseStatus,
        ...(fields.responseText === undefined ? {} : this.recordedBody(fields.responseText, request.recordResponseAs)),
        ...(fields.error === undefined ? {} : { error: this.scrub(fields.error) }),
      });

    let response: Response;
    let text: string;
    try {
      response = await this.fetch(new URL(request.path, this.options.baseUrl), {
        method: request.method,
        headers: {
          Accept: 'application/json',
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
          ...request.headers,
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(this.options.timeoutMilliseconds),
      });
      text = await response.text();
    } catch (error) {
      // `AbortSignal.timeout` rejects with a DOMException named TimeoutError (not always
      // `instanceof Error`). The message may echo the URL — it is scrubbed before recording.
      const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
      const reason = name === 'TimeoutError' ? 'timed out' : 'network error';
      await record({ error: `${reason}: ${typeof message === 'string' ? message : String(error)}` });
      throw new ProviderUnavailableError(`${label} ${request.operation} ${reason}`, request.operation);
    }

    const classification = request.classify(response.status, text);
    switch (classification.outcome) {
      case 'OK': {
        const providerCallId = await record({ responseStatus: response.status, responseText: text });
        return { status: response.status, value: classification.value, providerCallId };
      }
      case 'INVALID':
        await record({ responseStatus: response.status, responseText: text, error: classification.error });
        throw new ProviderResponseInvalidError(`${label} ${request.operation} ${classification.error}`, request.operation);
      case 'TRANSIENT':
        await record({ responseStatus: response.status, responseText: text, error: classification.error });
        if (classification.warning) this.logger.warn({ operation: request.operation, provider: this.options.provider }, classification.warning);
        throw new ProviderUnavailableError(`${label} ${request.operation} failed (${response.status})`, request.operation, response.status);
      case 'DEFINITIVE':
        await record({ responseStatus: response.status, responseText: text, error: classification.error });
        throw new ProviderRequestRejectedError(
          `${label} rejected ${request.operation} (${response.status})`,
          request.operation,
          response.status,
          classification.providerErrorCode,
        );
    }
  }

  private recordedBody(
    text: string,
    recordResponseAs = this.options.recordResponseAs,
  ): { responseBody?: unknown; responseBodyText?: string } {
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      return { responseBody: unparsedBody(this.scrub(text)) };
    }
    if (recordResponseAs === 'raw-json-text' && text.length > 0) {
      return { responseBodyText: this.scrub(text) };
    }
    if (recordResponseAs === 'redacted-lossless-json' && text.length > 0) {
      const redacted = redactJsonTextLosslessly(text, this.options.extraRedactedKeys);
      if (redacted !== undefined) return { responseBodyText: this.scrub(redacted) };
    }
    return { responseBody: parsed };
  }
}
