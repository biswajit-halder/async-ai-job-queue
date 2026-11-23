import type {
  ExecutionContext,
  ExportedHandler,
  MessageBatch,
  ScheduledController,
} from '@cloudflare/workers-types';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as db from './db/queries';
import { AppError, PermanentJobError } from './lib/errors';
import { retryDelaySeconds } from './lib/ids';
import { auth } from './middleware/auth';
import { onError } from './middleware/errorHandler';
import { rateLimit } from './middleware/rateLimit';
import { adminRoutes } from './routes/admin';
import { demoRoutes } from './routes/demo';
import { jobsRoutes } from './routes/jobs';
import { processJob } from './services/processor';
import { recoverQuotaFailures } from './services/recovery';
import { deliverCallback } from './services/webhook';
import type { AppEnv, Env, JobMessage } from './types';

const app = new Hono<AppEnv>();

export { app };

app.onError(onError);

const apiCors = cors({
  origin: (_origin, c) => c.env.ALLOWED_ORIGIN ?? '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Admin-Token'],
});
app.use('/v1/jobs', apiCors);
app.use('/v1/jobs/*', apiCors);
app.use('/v1/jobs', auth);
app.use('/v1/jobs', rateLimit);
app.use('/v1/jobs/*', auth);
app.use('/v1/jobs/*', rateLimit);

app.route('/v1/jobs', jobsRoutes);
app.route('/v1/demo', demoRoutes);
app.route('/admin', adminRoutes);

app.get('/', (c) =>
  c.json({
    name: 'async-ai-job-queue',
    version: '1.0.0',
    description:
      'Submit a URL or text, receive a job id, poll for a grounded summary. Queue + DLQ + content-hash cache on a free-tier Cloudflare Worker.',
    docs: 'README.md + openapi.yaml in repo',
    endpoints: [
      'POST /v1/jobs',
      'GET /v1/jobs/:id',
      'GET /v1/jobs',
      'DELETE /v1/jobs/:id',
      'POST /v1/demo/jobs',
      'POST /admin/seed',
    ],
  }),
);

app.get('/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

/**
 * Queue consumer. Permanent failures are acked; transient failures retry with
 * backoff and land in the dead-letter queue after MAX_ATTEMPTS. A 402 is marked
 * QUOTA_EXCEEDED so the nightly cron can requeue it when the daily budget resets.
 */
export async function queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    const attempts = message.attempts + 1;

    try {
      await processJob(env, job, attempts);
      message.ack();
      continue;
    } catch (error) {
      console.error(
        `[queue] job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const appError = error instanceof AppError ? error : null;
      const code = appError?.code ?? 'UPSTREAM_ERROR';
      const detail = error instanceof Error ? error.message : String(error);
      const terminal =
        error instanceof PermanentJobError ||
        (appError !== null && !appError.retryable) ||
        attempts >= Number(env.MAX_ATTEMPTS ?? 3);

      await db.failJob(env, job.id, `${code}: ${detail}`, terminal);

      if (terminal) {
        if (job.callbackUrl) {
          try {
            await deliverCallback(
              job.callbackUrl,
              job.callbackSecret,
              {
                id: job.id,
                status: 'dead_letter',
                result: null,
                error: `${code}: ${detail}`,
                updated_at: new Date().toISOString(),
              },
              Number(env.REQUEST_TIMEOUT_MS ?? 20_000),
            );
          } catch (callbackError) {
            console.warn(`[callback] failed for job ${job.id}: ${String(callbackError)}`);
          }
        }
        message.ack();
      } else {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  }
}

/** Optional cron entry point, used only when the account has a free cron slot. */
export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  await recoverQuotaFailures(env, 10);
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  queue,
  scheduled,
} satisfies ExportedHandler<Env, JobMessage>;
