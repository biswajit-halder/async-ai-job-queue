import type { ErrorHandler } from 'hono';
import { AppError } from '../lib/errors';
import type { AppEnv } from '../types';

export const onError: ErrorHandler<AppEnv> = (error, c) => {
  if (error instanceof AppError) {
    if (error.retryAfter !== undefined) c.header('Retry-After', String(error.retryAfter));
    if (error.status === 401) c.header('WWW-Authenticate', 'Bearer realm="async-ai-job-queue"');
    return c.json(error.toBody(), error.status as never);
  }

  console.error('[unhandled]', error);
  return c.json(
    { error: { code: 'INTERNAL', message: 'Internal server error', retryable: false } },
    500,
  );
};
