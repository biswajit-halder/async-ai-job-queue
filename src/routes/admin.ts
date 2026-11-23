import { Hono } from 'hono';
import { z } from 'zod';
import * as db from '../db/queries';
import { DEMO_EXAMPLES, seedDemoCache } from '../fixtures';
import { generateApiKey, sha256 } from '../lib/hash';
import { newId } from '../lib/ids';
import { NotFoundError, ValidationError } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import type { AppEnv } from '../types';

export const adminRoutes = new Hono<AppEnv>();

const createKeySchema = z.object({
  label: z.string().min(1).max(80).default('demo'),
  daily_limit: z.number().int().min(1).max(10_000).default(50),
  per_minute_limit: z.number().int().min(1).max(1000).default(20),
});

adminRoutes.use('*', requireAdmin);

adminRoutes.post('/keys', async (c) => {
  const parsed = createKeySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError('Invalid key request', parsed.error.issues);

  const { raw, prefix } = generateApiKey();
  await db.insertApiKey(c.env, {
    id: newId('key'),
    keyHash: await sha256(raw),
    keyPrefix: prefix,
    label: parsed.data.label,
    dailyLimit: parsed.data.daily_limit,
    perMinuteLimit: parsed.data.per_minute_limit,
  });

  return c.json(
    {
      key: raw,
      note: 'Store this key now — only its SHA-256 hash is retained.',
    },
    201,
  );
});

adminRoutes.get('/keys', async (c) => c.json({ items: await db.listApiKeys(c.env) }));

adminRoutes.delete('/keys/:id', async (c) => {
  const removed = await db.revokeApiKey(c.env, c.req.param('id'));
  if (!removed) throw new NotFoundError('Key not found');
  return c.body(null, 204);
});

adminRoutes.post('/seed', async (c) => {
  const seeded = await seedDemoCache(c.env);
  return c.json({ seeded, llmCalls: 0, examples: DEMO_EXAMPLES.map((item) => item.label) });
});

adminRoutes.get('/stats', async (c) =>
  c.json({
    jobs: await db.getJobCounts(c.env),
    demoExamples: DEMO_EXAMPLES.length,
  }),
);

adminRoutes.get('/usage', async (c) => {
  const keyId = c.req.query('key_id');
  if (!keyId) throw new ValidationError('key_id is required');
  const hours = Number(c.req.query('hours') ?? 24);
  const since = new Date(Date.now() - (Number.isFinite(hours) ? hours : 24) * 3_600_000);
  return c.json({ windowHours: hours, summary: await db.getUsageSummary(c.env, keyId, since) });
});
