import type {
  ApiKeyRow,
  Env,
  JobMessage,
  JobRow,
  RateRow,
  ResultRow,
  SummaryEvent,
} from '../types';

interface UsageRow {
  requests: number;
  llm_calls: number;
  cache_hits: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

/** D1's datetime('now') format, used for comparable filters. */
export function sqlTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

// ── API keys ────────────────────────────────────────────────────────────────

export async function findApiKeyByHash(env: Env, hash: string): Promise<ApiKeyRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<ApiKeyRow>()) ?? null
  );
}

export async function insertApiKey(
  env: Env,
  key: {
    id: string;
    keyHash: string;
    keyPrefix: string;
    label: string;
    dailyLimit: number;
    perMinuteLimit: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO api_keys (id, key_hash, key_prefix, label, daily_limit, per_minute_limit)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      key.id,
      key.keyHash,
      key.keyPrefix,
      key.label,
      key.dailyLimit,
      key.perMinuteLimit,
    )
    .run();
}

export async function listApiKeys(env: Env): Promise<ApiKeyRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, key_prefix, label, daily_limit, per_minute_limit, revoked, created_at, last_used_at
     FROM api_keys ORDER BY created_at DESC`,
  ).all<ApiKeyRow>();
  return result.results ?? [];
}

export async function revokeApiKey(env: Env, id: string): Promise<boolean> {
  const result = (await env.DB.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?')
    .bind(id)
    .run()) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

export async function touchApiKey(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

// ── Rate limits (same atomic pattern as the LLM Gateway) ────────────────────

export async function getRateCounter(env: Env, keyId: string): Promise<RateRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM rate_counters WHERE key_id = ?')
      .bind(keyId)
      .first<RateRow>()) ?? null
  );
}

export async function createRateCounter(
  env: Env,
  keyId: string,
  minuteStart: number,
  dayStart: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO rate_counters (key_id, minute_start, minute_count, day_start, day_count)
     VALUES (?, ?, 1, ?, 1)`,
  )
    .bind(keyId, minuteStart, dayStart)
    .run();
}

export async function resetRateCounter(
  env: Env,
  keyId: string,
  minuteStart: number,
  dayStart: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE rate_counters SET minute_start = ?, minute_count = 1, day_start = ?, day_count = 1
     WHERE key_id = ?`,
  )
    .bind(minuteStart, dayStart, keyId)
    .run();
}

export async function incrementRateCounter(
  env: Env,
  keyId: string,
  limits: { perMinute: number; daily: number },
): Promise<{ allowed: boolean; minuteRemaining: number; dayRemaining: number }> {
  const row = await env.DB.prepare(
    `UPDATE rate_counters SET minute_count = minute_count + 1, day_count = day_count + 1
     WHERE key_id = ? AND minute_count < ? AND day_count < ?
     RETURNING minute_count, day_count`,
  )
    .bind(keyId, limits.perMinute, limits.daily)
    .first<{ minute_count: number; day_count: number }>();

  if (!row) return { allowed: false, minuteRemaining: 0, dayRemaining: 0 };
  return {
    allowed: true,
    minuteRemaining: Math.max(0, limits.perMinute - row.minute_count),
    dayRemaining: Math.max(0, limits.daily - row.day_count),
  };
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export async function insertJob(
  env: Env,
  job: {
    id: string;
    keyId: string;
    kind: string;
    sourceType: string;
    sourceRef: string;
    sourcePayload: string | null;
    contentHash: string;
    callbackUrl: string | null;
    maxAttempts: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO jobs
       (id, api_key_id, kind, source_type, source_ref, source_payload, content_hash,
        status, max_attempts, callback_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
  )
    .bind(
      job.id,
      job.keyId,
      job.kind,
      job.sourceType,
      job.sourceRef,
      job.sourcePayload,
      job.contentHash,
      job.maxAttempts,
      job.callbackUrl,
    )
    .run();
}

export async function getJob(env: Env, id: string): Promise<JobRow | null> {
  return (await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>()) ?? null;
}

export async function listJobs(
  env: Env,
  keyId: string,
  limit: number,
  offset: number,
): Promise<JobRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM jobs WHERE api_key_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(keyId, limit, offset)
    .all<JobRow>();
  return result.results ?? [];
}

export async function countJobs(env: Env, keyId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM jobs WHERE api_key_id = ?')
    .bind(keyId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Atomic-ish claim: only queued/failed jobs can start. Completed and cancelled
 * jobs are skipped, which makes duplicate queue deliveries harmless.
 */
export async function claimJob(
  env: Env,
  id: string,
  attempts: number,
): Promise<{ status: 'claimed' | 'done' | 'missing'; job: JobRow | null }> {
  const job = await getJob(env, id);
  if (!job) return { status: 'missing', job: null };
  if (job.status === 'completed' || job.status === 'cancelled') return { status: 'done', job };

  if (job.status === 'processing') return { status: 'done', job };

  await env.DB.prepare(
    `UPDATE jobs SET status = 'processing', attempts = ?, updated_at = datetime('now')
     WHERE id = ? AND status IN ('queued', 'failed')`,
  )
    .bind(attempts, id)
    .run();

  // Verify by re-reading. D1's `changes` count is not reliable in every local
  // runtime, and a second delivery may have won the race between the two reads.
  const current = await getJob(env, id);
  if (!current || current.status !== 'processing' || current.attempts !== attempts) {
    return { status: 'done', job: current ?? job };
  }
  return { status: 'claimed', job: current };
}

export async function completeJob(env: Env, id: string, resultId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'completed', result_id = ?, error = NULL,
       completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(resultId, id)
    .run();
}

export async function failJob(
  env: Env,
  id: string,
  error: string,
  deadLetter = false,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(deadLetter ? 'dead_letter' : 'failed', error.slice(0, 1000), id)
    .run();
}

export async function cancelQueuedJob(env: Env, id: string): Promise<boolean> {
  const result = (await env.DB.prepare(
    `UPDATE jobs SET status = 'cancelled', updated_at = datetime('now')
     WHERE id = ? AND status = 'queued'`,
  )
    .bind(id)
    .run()) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

/** Jobs that failed only because the free quota ran out, older than one day. */
export async function listQuotaFailures(env: Env, limit: number): Promise<JobRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM jobs
     WHERE status = 'failed' AND error LIKE 'QUOTA_EXCEEDED%'
       AND updated_at < datetime('now', '-1 day')
     ORDER BY updated_at ASC LIMIT ?`,
  )
    .bind(limit)
    .all<JobRow>();
  return result.results ?? [];
}

export async function requeueJob(env: Env, id: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, updated_at = datetime('now')
     WHERE id = ? AND status = 'failed'`,
  )
    .bind(id)
    .run();
}

export function toJobMessage(job: JobRow): JobMessage {
  return {
    id: job.id,
    keyId: job.api_key_id,
    kind: job.kind as JobMessage['kind'],
    sourceType: job.source_type as JobMessage['sourceType'],
    sourceValue: job.source_type === 'text' ? (job.source_payload ?? job.source_ref) : job.source_ref,
    contentHash: job.content_hash,
    callbackUrl: job.callback_url ?? undefined,
    createdAt: job.created_at,
  };
}

// ── Results & usage ─────────────────────────────────────────────────────────

export async function insertResult(
  env: Env,
  result: {
    id: string;
    jobId: string;
    summary: string;
    keyPoints: string[];
    model: string;
    sourceType: string;
    sourceRef: string;
    promptTokens: number;
    completionTokens: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO results
       (id, job_id, summary, key_points, model, source_type, source_ref, prompt_tokens, completion_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      result.id,
      result.jobId,
      result.summary,
      JSON.stringify(result.keyPoints),
      result.model,
      result.sourceType,
      result.sourceRef,
      result.promptTokens,
      result.completionTokens,
    )
    .run();
}

export async function getResult(env: Env, id: string): Promise<ResultRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM results WHERE id = ?').bind(id).first<ResultRow>()) ?? null
  );
}

export async function insertUsageEvent(
  env: Env,
  event: {
    id: string;
    jobId: string;
    keyId: string;
    model: string;
    cache: 'HIT' | 'MISS';
    promptTokens: number;
    completionTokens: number;
    attempts: number;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO usage_events
       (id, job_id, key_id, model, cache, prompt_tokens, completion_tokens, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      event.id,
      event.jobId,
      event.keyId,
      event.model,
      event.cache,
      event.promptTokens,
      event.completionTokens,
      event.attempts,
    )
    .run();
}

export async function getUsageSummary(env: Env, keyId: string, since: Date): Promise<SummaryEvent> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN cache = 'HIT' THEN 1 ELSE 0 END) AS cache_hits,
            SUM(CASE WHEN cache = 'MISS' THEN 1 ELSE 0 END) AS llm_calls,
            SUM(prompt_tokens) AS prompt_tokens,
            SUM(completion_tokens) AS completion_tokens
     FROM usage_events WHERE key_id = ? AND created_at >= ?`,
  )
    .bind(keyId, sqlTime(since))
    .first<UsageRow>();

  return {
    requests: row?.requests ?? 0,
    cacheHits: row?.cache_hits ?? 0,
    llmCalls: row?.llm_calls ?? 0,
    promptTokens: row?.prompt_tokens ?? 0,
    completionTokens: row?.completion_tokens ?? 0,
  };
}

export async function getJobCounts(env: Env): Promise<Record<string, number>> {
  const result = await env.DB.prepare('SELECT status, COUNT(*) AS total FROM jobs GROUP BY status').all<{
    status: string;
    total: number;
  }>();
  const counts: Record<string, number> = {};
  for (const row of result.results ?? []) counts[row.status] = row.total;
  return counts;
}
