import { SetMetadata } from '@nestjs/common';
import { ErrorCode } from '../common/errors';

export const API_ERRORS_KEY = 'openapi:errors';

/**
 * The error codes THIS route's own logic can raise (services, executors, the route's guard), documented per status
 * against the shared `ErrorResponse` (design §12.1). Pipeline codes (authentication, roles, unverified, the
 * idempotency barrier, rate limits, validation, busy database) are added by `buildOpenApiDocument` from the route's
 * real metadata — do not repeat them here.
 */
export const ApiErrors = (...codes: ErrorCode[]): MethodDecorator => SetMetadata(API_ERRORS_KEY, codes);
