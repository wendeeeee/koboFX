import { SetMetadata } from '@nestjs/common';
import { ErrorCode } from '../common/errors';

export const API_ERRORS_KEY = 'openapi:errors';


export const ApiErrors = (...codes: ErrorCode[]): MethodDecorator => SetMetadata(API_ERRORS_KEY, codes);
