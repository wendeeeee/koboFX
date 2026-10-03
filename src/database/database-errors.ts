import { ResourceBusyError } from '../common/errors';

/**
 * SQLSTATEs that mean "try again". They become
 * `503 RESOURCE_BUSY`, and idempotency treats them as transient so a retry with the same key genuinely reprocesses.
 */
const TRANSIENT_SQLSTATES: Readonly<Record<string, string>> = {
  '55P03': 'lock_timeout',
  '57014': 'statement_timeout',
  '40P01': 'deadlock_detected',
  '40001': 'serialization_failure',
};

export function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  const code = candidate.driverError?.code ?? candidate.code;
  return typeof code === 'string' ? code : undefined;
}

/** The violated constraint's name, when the driver reports one. */
export function constraintName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { constraint?: unknown; driverError?: { constraint?: unknown } };
  const name = candidate.driverError?.constraint ?? candidate.constraint;
  return typeof name === 'string' ? name : undefined;
}

/** Map transient database failures to domain errors */
export function translateDatabaseError(error: unknown): unknown {
  const state = sqlState(error);
  const reason = state ? TRANSIENT_SQLSTATES[state] : undefined;
  if (!reason) return error;
  return new ResourceBusyError(
    'The resource is busy. Retry the request with the same Idempotency-Key.',
    { reason },
    { cause: error },
  );
}
