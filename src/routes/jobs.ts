import { Hono } from 'hono';
import * as db from '../db/queries';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { createJobSchema, listJobsQuery } from '../lib/validate';
import { submitJob } from '../services/submissions';
import type { AppEnv, JobRow, ResultRow } from '../types';

export const jobsRoutes = new Hono<AppEnv>();

function serializeResult(result: ResultRow | null) {
  if (!result) return null;
  return {
    summary: result.summary,
    key_points: JSON.parse(result.key_points) as string[],
    model: result.model,
    source_type: result.source_type,
    source_ref: result.source_ref,
    prompt_tokens: result.prompt_tokens,
    completion_tokens: result.completion_tokens,
    created_at: result.created_at,
  };
}

function serializeJob(job: JobRow, result: ResultRow | null) {
  return {
    id: job.id,
    status: job.status,
    kind: job.kind,
    source_type: job.source_type,
    source_ref: job.source_ref,
    attempts: job.attempts,
    error: job.error,
    result: serializeResult(result),
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  };
}

jobsRoutes.post('/', async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = createJobSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid job request', parsed.error.issues);
  }

  const { id } = await submitJob(c.env, parsed.data, c.get('auth').keyId);
  c.header('Location', `/v1/jobs/${id}`);
  return c.json({ id, status: 'queued', poll_url: `/v1/jobs/${id}` }, 202);
});

jobsRoutes.get('/', async (c) => {
  const query = listJobsQuery.parse({
    limit: c.req.query('limit'),
    offset: c.req.query('offset'),
  });
  const keyId = c.get('auth').keyId;
  const [jobs, total] = await Promise.all([
    db.listJobs(c.env, keyId, query.limit, query.offset),
    db.countJobs(c.env, keyId),
  ]);
  return c.json({
    items: jobs.map((job) => serializeJob(job, null)),
    pagination: { limit: query.limit, offset: query.offset, total },
  });
});

jobsRoutes.get('/:id', async (c) => {
  const job = await db.getJob(c.env, c.req.param('id'));
  if (!job || job.api_key_id !== c.get('auth').keyId) throw new NotFoundError('Job not found');

  const result = job.result_id ? await db.getResult(c.env, job.result_id) : null;
  return c.json(serializeJob(job, result));
});

jobsRoutes.delete('/:id', async (c) => {
  const job = await db.getJob(c.env, c.req.param('id'));
  if (!job || job.api_key_id !== c.get('auth').keyId) throw new NotFoundError('Job not found');
  if (job.status !== 'queued') {
    throw new ConflictError(`A ${job.status} job cannot be cancelled`);
  }

  const cancelled = await db.cancelQueuedJob(c.env, job.id);
  if (!cancelled) throw new ConflictError('The job was already picked up by a worker');
  return c.body(null, 204);
});
