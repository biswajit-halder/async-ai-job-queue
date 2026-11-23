export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SSRF_BLOCKED'
  | 'FETCH_FAILED'
  | 'INVALID_CONTENT'
  | 'QUOTA_EXCEEDED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly retryable: boolean = false,
    public readonly details?: unknown,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super('VALIDATION_ERROR', 400, message, false, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'A valid API key is required') {
    super('UNAUTHORIZED', 401, message);
  }
}

export class RateLimitedError extends AppError {
  constructor(message = 'Rate limit exceeded', retryAfter = 60) {
    super('RATE_LIMITED', 429, message, true, undefined, retryAfter);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', 404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'The resource is in a conflicting state') {
    super('CONFLICT', 409, message);
  }
}

export class SsrfBlockedError extends AppError {
  constructor(message = 'The URL is not allowed') {
    super('SSRF_BLOCKED', 400, message);
  }
}

export class FetchFailedError extends AppError {
  constructor(message = 'The source could not be fetched') {
    super('FETCH_FAILED', 422, message, true);
  }
}

export class InvalidContentError extends AppError {
  constructor(message = 'The source has no usable text') {
    super('INVALID_CONTENT', 422, message);
  }
}

export class QuotaExceededError extends AppError {
  constructor(message = 'OpenRouter free quota exhausted') {
    super('QUOTA_EXCEEDED', 402, message, false);
  }
}

export class UpstreamError extends AppError {
  constructor(message = 'Upstream model provider failed') {
    super('UPSTREAM_ERROR', 502, message, true);
  }
}

/** Signals to the queue consumer that a job must not be retried. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
