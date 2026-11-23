import { Hono } from 'hono';
import { z } from 'zod';
import * as db from '../db/queries';
import { DEMO_EXAMPLES } from '../fixtures';
import { RateLimitedError, ValidationError } from '../lib/errors';
import { submitJob } from '../services/submissions';
import type { AppEnv } from '../types';

export const demoRoutes = new Hono<AppEnv>();

const submitSchema = z.object({ label: z.string().min(1).max(80) });
const DEMO_KEY_ID = 'key_demo';

demoRoutes.get('/', (c) =>
  c.json({
    name: 'async-ai-job-queue demo',
    note: 'Public demo submissions are capped daily. Canned answers are pre-warmed by POST /admin/seed.',
    endpoints: ['GET /v1/demo/examples', 'POST /v1/demo/jobs'],
  }),
);

demoRoutes.get('/examples', (c) =>
  c.json({
    examples: DEMO_EXAMPLES.map((example) => ({
      label: example.label,
      preview: `${example.text.slice(0, 140)}…`,
    })),
  }),
);

demoRoutes.post('/jobs', async (c) => {
  const parsed = submitSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError('Invalid demo request', parsed.error.issues);

  const example = DEMO_EXAMPLES.find((item) => item.label === parsed.data.label);
  if (!example) throw new ValidationError(`Unknown demo label: ${parsed.data.label}`);

  const counterKey = `demo:daily:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await c.env.CACHE.get(counterKey)) ?? '0');
  const limit = Number(c.env.DEMO_DAILY_LIMIT ?? 20);
  if (used >= limit) throw new RateLimitedError('Demo daily limit reached', 3600);
  await c.env.CACHE.put(counterKey, String(used + 1), { expirationTtl: 86_400 });

  const { id } = await submitJob(
    c.env,
    { kind: 'summary', text: example.text },
    DEMO_KEY_ID,
  );
  c.header('Location', `/v1/demo/jobs/${id}`);
  return c.json({ id, status: 'queued', label: example.label }, 202);
});

demoRoutes.get('/jobs/:id', async (c) => {
  const job = await db.getJob(c.env, c.req.param('id'));
  if (!job || job.api_key_id !== DEMO_KEY_ID) {
    throw new ValidationError('Demo job not found');
  }
  const result = job.result_id ? await db.getResult(c.env, job.result_id) : null;
  return c.json({
    id: job.id,
    status: job.status,
    error: job.error,
    result: result
      ? { summary: result.summary, key_points: JSON.parse(result.key_points) as string[] }
      : null,
  });
});
