import { createHash } from 'node:crypto';
import { ResponseClassification, ProviderHttpClient } from '../../../../common/http/provider-http-client';
import { ProviderCallRecorder } from '../../../../common/http/provider-call-recorder';
import { ProviderRequestRejectedError, ProviderResponseInvalidError, ProviderUnavailableError } from '../../../../common/http/provider.errors';
import { RandomSource } from '../../../../common/polling/backoff';
import { parsePaystackTransferJson } from './paystack-transfer-responses';
import {
  PaystackTransferCallFailedError,
  PaystackTransferRefusal,
  ProviderExchange,
  TransferCallFailureKind,
} from './paystack-transfers.port';

export interface PaystackTransfersHttpClientOptions {
  readonly provider: string;
  readonly baseUrl: string;
  readonly secretKey: string;
  readonly timeoutMilliseconds: number;
  readonly writeTimeoutMilliseconds: number;
  readonly readRetries: number;
  readonly retryBaseMilliseconds?: number;
  readonly retryCapMilliseconds?: number;
  readonly random?: RandomSource;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly fetch?: typeof fetch;
}

export interface TransfersRequest {
  readonly operation: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly recordedPath?: string;
  readonly rawBody?: string;
  readonly recordedBody?: unknown;
  readonly sensitiveValues?: readonly string[];
  readonly flowId?: string;
}

/**
 * Keys never recorded from transfer-side bodies (§H): account numbers and names, recipient objects and details,
 * narration, metadata, contact details. The exact bytes live in protected evidence instead.
 */
export const PAYSTACK_TRANSFER_REDACTED_KEYS =
  /^(customer|ip_address|first_name|last_name|account_number|account_name|name|details|recipient|narration|reason|description|metadata|authorization_code|phone)$/i;

function messageOf(body: unknown): string {
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message.toLowerCase() : '';
}

function codeOf(body: unknown): string | null {
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code.slice(0, 64).toLowerCase() : null;
}

/**
 * What a transfer-side answer means (§E.3, §H). An error body wins over the HTTP status: a `2xx` with `status:false` is
 * TRANSIENT (no answer), an auth or entitlement problem is CONFIGURATION (review, never a money failure), and only the
 * named refusals carry meaning — callers decide what each means after an uncertain write (none of them proves an
 * earlier send failed).
 */
export function classifyTransferResponse(status: number, text: string): ResponseClassification<unknown> {
  let body: unknown;
  try {
    body = text.length === 0 ? null : parsePaystackTransferJson(text);
  } catch {
    return { outcome: 'INVALID', error: 'unparseable JSON' };
  }
  if (status >= 500 || status === 429) return { outcome: 'TRANSIENT', error: `provider error ${status}` };
  if (status >= 200 && status < 300) {
    const flag = typeof body === 'object' && body !== null ? (body as { status?: unknown }).status : undefined;
    if (flag === true) return { outcome: 'OK', value: body };
    return { outcome: 'TRANSIENT', error: 'status is not true', warning: 'Paystack returned 2xx without status:true' };
  }
  const message = messageOf(body);
  const code = codeOf(body);
  const refuse = (refusal: PaystackTransferRefusal, error: string) => ({ outcome: 'DEFINITIVE' as const, error, providerErrorCode: refusal });
  if (status === 401 || status === 403 || code === 'invalid_key' || message.includes('invalid key')) {
    return refuse(PaystackTransferRefusal.CONFIGURATION, 'authentication or authorization');
  }
  if (/third party payouts|starter business|transfers? (is|are) not (enabled|available)|not allowed to (make|initiate) transfers/.test(message)) {
    return refuse(PaystackTransferRefusal.CONFIGURATION, 'transfers not enabled');
  }
  if (message.includes('duplicate') && message.includes('reference')) return refuse(PaystackTransferRefusal.DUPLICATE_REFERENCE, 'duplicate reference');
  if (/balance is not enough|insufficient balance|insufficient funds/.test(message)) {
    return refuse(PaystackTransferRefusal.INSUFFICIENT_BALANCE, 'insufficient provider balance');
  }
  if (/could not resolve|unknown bank code|invalid account|account number is invalid/.test(message)) {
    return refuse(PaystackTransferRefusal.ACCOUNT_NOT_RESOLVED, 'account not resolved');
  }
  if (status === 404 || message.includes('not found')) return refuse(PaystackTransferRefusal.NOT_FOUND, 'not found');
  return { outcome: 'DEFINITIVE', error: `rejected ${code ?? status}`, providerErrorCode: PaystackTransferRefusal.REJECTED };
}

/**
 * The transfer-side transport: the shared `ProviderHttpClient` (timeouts, retries for reads ONLY, `provider_calls`),
 * plus the exact bytes of the last attempt for protected evidence. Unparsed bodies are withheld from `provider_calls`;
 * per-request sensitive values (an account number in a query) are scrubbed from every recorded text.
 */
export class PaystackTransfersHttpClient {
  private readonly reads: ProviderHttpClient;
  private readonly writes: ProviderHttpClient;

  constructor(
    private readonly options: PaystackTransfersHttpClientOptions,
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
      extraRedactedKeys: PAYSTACK_TRANSFER_REDACTED_KEYS,
      withholdUnparsedBodies: true,
      random: options.random,
      sleep: options.sleep,
      fetch: options.fetch,
    };
    this.reads = new ProviderHttpClient({ ...shared, timeoutMilliseconds: options.timeoutMilliseconds }, recorder);
    this.writes = new ProviderHttpClient({ ...shared, timeoutMilliseconds: options.writeTimeoutMilliseconds }, recorder);
  }

  async send(request: TransfersRequest): Promise<{ body: unknown; exchange: ProviderExchange }> {
    const write = request.method === 'POST';
    const requestSha256 = request.rawBody === undefined ? null : createHash('sha256').update(request.rawBody, 'utf8').digest();
    let last: { status: number; text: string } | null = null;
    const exchange = (providerCallId?: string): ProviderExchange => ({
      operation: request.operation,
      httpStatus: last?.status ?? null,
      rawResponse: last === null ? null : Buffer.from(last.text, 'utf8'),
      providerCallId,
      requestSha256,
    });
    try {
      const response = await (write ? this.writes : this.reads).send({
        operation: request.operation,
        method: request.method,
        path: request.path,
        recordedPath: request.recordedPath,
        rawBody: request.rawBody,
        recordedBody: request.recordedBody,
        sensitiveValues: request.sensitiveValues,
        flowId: request.flowId,
        retryable: !write,
        headers: { Authorization: `Bearer ${this.options.secretKey}` },
        beforeAttempt: async () => {
          last = null;
        },
        classify: (status, text) => {
          last = { status, text };
          return classifyTransferResponse(status, text);
        },
      });
      return { body: response.value, exchange: exchange(response.providerCallId) };
    } catch (error) {
      if (error instanceof ProviderRequestRejectedError) {
        const refusal = (error.providerErrorCode as PaystackTransferRefusal | null) ?? PaystackTransferRefusal.REJECTED;
        const kind = refusal === PaystackTransferRefusal.CONFIGURATION ? TransferCallFailureKind.CONFIGURATION : TransferCallFailureKind.REFUSED;
        throw new PaystackTransferCallFailedError(kind, refusal, exchange(), `Paystack refused ${request.operation} (${refusal}).`);
      }
      if (error instanceof ProviderResponseInvalidError) {
        throw new PaystackTransferCallFailedError(TransferCallFailureKind.INVALID, null, exchange(), `Paystack ${request.operation}: unreadable answer.`);
      }
      if (error instanceof ProviderUnavailableError) {
        throw new PaystackTransferCallFailedError(TransferCallFailureKind.TRANSIENT, null, exchange(), `Paystack ${request.operation}: no answer.`);
      }
      throw error;
    }
  }
}
