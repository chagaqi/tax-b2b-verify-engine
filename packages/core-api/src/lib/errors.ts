import type { ZodError } from 'zod';

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'quota_exceeded'
  | 'plan_required'
  | 'rate_limited'
  | 'conflict'
  | 'upstream_error'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502 | 503,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) } };
  }
}

export function zodToApiError(err: ZodError): ApiError {
  return new ApiError(
    400,
    'validation_failed',
    'Request validation failed',
    err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}
