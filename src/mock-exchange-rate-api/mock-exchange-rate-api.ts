import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { Request, Response } from 'express';

/**
 * A simulated ExchangeRate-API (Phase 6 §5.11), in the `mock-psp` style: a real HTTP
 * server, so the adapter really sees status codes, `200`s carrying error bodies, garbage,
 * timeouts and 429s. NOT part of the application: nothing under `src/modules` imports it.
 *
 * It speaks both documented shapes exactly (checked 2026-09-29):
 * - open access: `GET /v6/latest/{BASE}` → `{ result, provider, …, time_eol_unix, base_code, rates }`;
 * - keyed v6: `GET /v6/{KEY}/latest/{BASE}` → `{ result, …, base_code, conversion_rates }`, and a
 *   wrong key → HTTP 403 `{ result: "error", "error-type": "invalid-key" }` (as recorded).
 *
 * Rates are held as RAW TEXT and written into the body verbatim, so a test can serve
 * `1530.123456789012345`, `1.2e-5`, `0` or `-1` exactly as a provider might. Scripted
 * faults are consumed one per request, in order; `requests` counts every request.
 */
export type MockFault =
  | { readonly kind: 'error-type'; readonly errorType: string; readonly status?: number }
  | { readonly kind: 'server-error'; readonly status?: number }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'garbage' }
  | { readonly kind: 'raw'; readonly status: number; readonly body: string }
  | { readonly kind: 'hang'; readonly milliseconds: number };

export interface MockPublication {
  /** Currency → rate as raw JSON number text (or anything else, to test malformed rates). */
  readonly rates: Readonly<Record<string, string>>;
  readonly publishedAt: Date;
  readonly nextUpdateAt: Date;
  readonly baseCode?: string;
}

export interface MockExchangeRateApiOptions {
  /** When set, the keyed route requires it; the open route needs none either way. */
  readonly apiKey?: string;
}

/** Today's real values (recorded 2026-09-29), as the default publication. */
export const RECORDED_RATES: Readonly<Record<string, string>> = {
  USD: '1',
  NGN: '1329.375909',
  EUR: '0.879241',
  GBP: '0.754467',
  JPY: '157.315109',
  KWD: '0.308645',
};

export class MockExchangeRateApi {
  private server: Server | undefined;
  private publication: MockPublication;
  private readonly faults: MockFault[] = [];
  private readonly hangs = new Set<NodeJS.Timeout>();
  /** Every request received (after nothing is filtered: faults, errors and hangs included). */
  requests = 0;

  constructor(private readonly options: MockExchangeRateApiOptions = {}) {
    const now = Date.now();
    this.publication = { rates: RECORDED_RATES, publishedAt: new Date(now - 60_000), nextUpdateAt: new Date(now + 86_400_000) };
  }

  /** Publish new rates (what the next successful request returns). */
  publish(publication: Partial<MockPublication> & Pick<MockPublication, 'publishedAt' | 'nextUpdateAt'>): void {
    this.publication = { ...this.publication, ...publication };
  }

  get current(): MockPublication {
    return this.publication;
  }

  /** Queue faults: each is used by exactly one request, in order. */
  failNext(...faults: MockFault[]): void {
    this.faults.push(...faults);
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  async start(port = 0, host = '127.0.0.1'): Promise<string> {
    const app = express();
    app.disable('x-powered-by');
    app.get('/v6/latest/:base', (request, response) => this.handle(request, response, 'open'));
    app.get('/v6/:key/latest/:base', (request, response) => this.handle(request, response, 'keyed'));
    app.use((_request, response) => {
      response.status(404).type('application/json').send('{"result":"error","error-type":"malformed-request"}');
    });
    await new Promise<void>((resolve) => {
      this.server = app.listen(port, host, () => resolve());
    });
    const address = this.server!.address() as AddressInfo;
    return `http://${host}:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const timer of this.hangs) clearTimeout(timer);
    this.hangs.clear();
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
  }

  private handle(request: Request, response: Response, route: 'open' | 'keyed'): void {
    this.requests += 1;
    const fault = this.faults.shift();
    if (fault) {
      this.applyFault(fault, response);
      return;
    }
    if (route === 'keyed' && String(request.params.key) !== this.options.apiKey) {
      this.sendError(response, 403, 'invalid-key');
      return;
    }
    const base = String(request.params.base);
    if (!/^[A-Z]{3}$/.test(base)) {
      this.sendError(response, 400, 'malformed-request');
      return;
    }
    if (base !== 'USD') {
      // The simulated provider only publishes USD-based rates.
      this.sendError(response, 404, 'unsupported-code');
      return;
    }
    response.status(200).type('application/json').send(this.body(route));
  }

  private body(route: 'open' | 'keyed'): string {
    const { rates, publishedAt, nextUpdateAt, baseCode = 'USD' } = this.publication;
    const last = Math.floor(publishedAt.getTime() / 1000);
    const next = Math.floor(nextUpdateAt.getTime() / 1000);
    const table = `{${Object.entries(rates).map(([code, rate]) => `${JSON.stringify(code)}:${rate}`).join(',')}}`;
    const common =
      `"result":"success","documentation":"https://www.exchangerate-api.com/docs","terms_of_use":"https://www.exchangerate-api.com/terms",` +
      `"time_last_update_unix":${last},"time_last_update_utc":${JSON.stringify(publishedAt.toUTCString())},` +
      `"time_next_update_unix":${next},"time_next_update_utc":${JSON.stringify(nextUpdateAt.toUTCString())},`;
    return route === 'open'
      ? `{${common.replace('"result":"success",', '"result":"success","provider":"https://www.exchangerate-api.com",')}"time_eol_unix":0,"base_code":${JSON.stringify(baseCode)},"rates":${table}}`
      : `{${common}"base_code":${JSON.stringify(baseCode)},"conversion_rates":${table}}`;
  }

  private sendError(response: Response, status: number, errorType: string): void {
    response
      .status(status)
      .type('application/json')
      .send(`{"result":"error","documentation":"https://www.exchangerate-api.com/docs","terms-of-use":"https://www.exchangerate-api.com/terms","error-type":${JSON.stringify(errorType)}}`);
  }

  private applyFault(fault: MockFault, response: Response): void {
    switch (fault.kind) {
      case 'error-type':
        this.sendError(response, fault.status ?? 200, fault.errorType);
        return;
      case 'server-error':
        response.status(fault.status ?? 503).type('text/html').send('<html><body>Service Unavailable</body></html>');
        return;
      case 'rate-limited':
        response.status(429).type('text/plain').send('Too Many Requests');
        return;
      case 'garbage':
        response.status(200).type('application/json').send('{"result":"success","rates":{"USD":1,"NGN":');
        return;
      case 'raw':
        response.status(fault.status).type('application/json').send(fault.body);
        return;
      case 'hang': {
        const timer = setTimeout(() => {
          this.hangs.delete(timer);
          if (!response.headersSent) response.status(200).type('application/json').send(this.body('open'));
        }, fault.milliseconds);
        this.hangs.add(timer);
        return;
      }
    }
  }
}
