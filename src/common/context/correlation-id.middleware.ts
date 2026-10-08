import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { RequestContext } from './request-context';

export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** Client-supplied ids are accepted for tracing, but only in a safe shape (no log injection). */
const ACCEPTABLE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export type RequestWithCorrelation = Request & { correlationId?: string };

/**
 * Registered first, as plain Express middleware, so everything after it — logging,
 * guards, handlers, the exception filter — runs inside the request's context.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_ID_HEADER);
  const correlationId = incoming && ACCEPTABLE_ID.test(incoming) ? incoming : randomUUID();
  (req as RequestWithCorrelation).correlationId = correlationId;
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  RequestContext.run({ correlationId }, () => next());
}
