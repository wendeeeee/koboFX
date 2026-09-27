import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { RequestContext, RequestWithCorrelation } from '../context';
import { buildErrorResponse } from './error-response';

/** Every error leaves the API in the §12.1 shape, with the request's correlation id. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithCorrelation>();
    const res = http.getResponse<Response>();
    const correlationId = RequestContext.correlationId() ?? req.correlationId ?? null;

    const { status, body, headers, isServerError } = buildErrorResponse(exception, correlationId);
    if (isServerError) {
      this.logger.error(
        { err: exception, correlationId, code: body.code },
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    if (res.headersSent) return;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(status).json(body);
  }
}
