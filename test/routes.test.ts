import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../src/db/queries';
import { app } from '../src/index';
import { submitJob } from '../src/services/submissions';
import { createMockKv, jobRow, makeEnv } from './helpers';

vi.mock('../src/db/queries', () => ({
  findApiKeyByHash: vi.fn(),
  touchApiKey: vi.fn(),
  getRateCounter: vi.fn(),
  createRateCounter: vi.fn(),
  resetRateCounter: vi.fn(),
  incrementRateCounter: vi.fn(),
  getJob: vi.fn(),
  listJobs: vi.fn(),
  countJobs: vi.fn(),
  getResult: vi.fn(),
  cancelQueuedJob: vi.fn(),
  getUsageSummary: vi.fn(),
  listApiKeys: vi.fn(),
  insertApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  getJobCounts: vi.fn(),
}));
vi.mock('../src/services/submissions', () => ({ submitJob: vi.fn() }));

const authHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' };
const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-token': 'admin-test' };

beforeEach(() => {
  vi.mocked(db.findApiKeyByHash).mockResolvedValue({
    id: 'key_1',
    key_hash: 'hash',
    key_prefix: 'abcd1234',
    label: 'test',
    daily_limit: 50,
    per_minute_limit: 20,
    revoked: 0,
    created_at: '2026-11-23 00:00:00',
    last_used_at: null,
  });
  vi.mocked(db.touchApiKey).mockResolvedValue(undefined);
  vi.mocked(db.getRateCounter).mockResolvedValue(null);
  vi.mocked(db.createRateCounter).mockResolvedValue(undefined);
  vi.mocked(db.resetRateCounter).mockResolvedValue(undefined);
  vi.mocked(db.incrementRateCounter).mockResolvedValue({
    allowed: true,
    minuteRemaining: 19,
    dayRemaining: 49,
  });
  vi.mocked(submitJob).mockResolvedValue({ id: 'job_1', hash: 'hash_1' });
  vi.mocked(db.getJob).mockResolvedValue(jobRow());
  vi.mocked(db.listJobs).mockResolvedValue([jobRow()]);
  vi.mocked(db.countJobs).mockResolvedValue(1);
  vi.mocked(db.getResult).mockResolvedValue({
    id: 'res_1',
    job_id: 'job_1',
    summary: 'A summary',
    key_points: '["one","two"]',
    model: 'm1:free',
    source_type: 'text',
    source_ref: 'source',
    prompt_tokens: 10,
    completion_tokens: 5,
    created_at: '2026-11-23 00:00:00',
  });
  vi.mocked(db.cancelQueuedJob).mockResolvedValue(true);
  vi.mocked(db.getUsageSummary).mockResolvedValue({
    requests: 2,
    llmCalls: 0,
    cacheHits: 2,
    promptTokens: 0,
    completionTokens: 0,
  });
  vi.mocked(db.listApiKeys).mockResolvedValue([]);
  vi.mocked(db.insertApiKey).mockResolvedValue(undefined);
  vi.mocked(db.revokeApiKey).mockResolvedValue(true);
  vi.mocked(db.getJobCounts).mockResolvedValue({ queued: 1 });
});

describe('public routes', () => {
  it('answers /health without credentials', async () => {
    const res = await app.request('/health', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('job routes', () => {
  it('rejects a missing API key with 401', async () => {
    const res = await app.request(
      '/v1/jobs',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"..."}' },
      makeEnv(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
  });

  it('accepts a submission and returns 202 with a poll URL', async () => {
    const res = await app.request(
      '/v1/jobs',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ text: 'A'.repeat(60) }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(202);
    expect(res.headers.get('Location')).toBe('/v1/jobs/job_1');
    expect(await res.json()).toMatchObject({ id: 'job_1', status: 'queued' });
    expect(submitJob).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid submissions before creating a job', async () => {
    const res = await app.request(
      '/v1/jobs',
      { method: 'POST', headers: authHeaders, body: JSON.stringify({ text: 'short' }) },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('returns status and result on the poll endpoint', async () => {
    vi.mocked(db.getJob).mockResolvedValueOnce(jobRow({ status: 'completed', result_id: 'res_1' }));
    const res = await app.request('/v1/jobs/job_1', { headers: authHeaders }, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: 'job_1',
      status: 'completed',
      result: { summary: 'A summary', key_points: ['one', 'two'] },
    });
  });

  it('does not expose another key’s job', async () => {
    vi.mocked(db.getJob).mockResolvedValueOnce(jobRow({ api_key_id: 'other_key' }));
    const res = await app.request('/v1/jobs/job_1', { headers: authHeaders }, makeEnv());
    expect(res.status).toBe(404);
  });

  it('lists jobs with pagination', async () => {
    const res = await app.request('/v1/jobs?limit=5&offset=0', { headers: authHeaders }, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pagination: { limit: 5, offset: 0, total: 1 } });
  });

  it('cancels a queued job but refuses a processing one', async () => {
    const cancelled = await app.request(
      '/v1/jobs/job_1',
      { method: 'DELETE', headers: authHeaders },
      makeEnv(),
    );
    expect(cancelled.status).toBe(204);

    vi.mocked(db.getJob).mockResolvedValueOnce(jobRow({ status: 'processing' }));
    const refused = await app.request(
      '/v1/jobs/job_1',
      { method: 'DELETE', headers: authHeaders },
      makeEnv(),
    );
    expect(refused.status).toBe(409);
  });
});

describe('admin and demo routes', () => {
  it('requires the admin token', async () => {
    const res = await app.request('/admin/keys', {}, makeEnv());
    expect(res.status).toBe(401);
  });

  it('issues a key exactly once', async () => {
    const res = await app.request(
      '/admin/keys',
      { method: 'POST', headers: adminHeaders, body: JSON.stringify({ label: 'demo' }) },
      makeEnv(),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { key: string };
    expect(data.key).toMatch(/^ajk_[0-9a-f]{48}$/);
    expect(db.insertApiKey).toHaveBeenCalledTimes(1);
  });

  it('pre-warms demo answers with zero LLM calls', async () => {
    const kv = createMockKv();
    const env = makeEnv({ CACHE: kv as unknown as ReturnType<typeof makeEnv>['CACHE'] });
    const res = await app.request('/admin/seed', { method: 'POST', headers: adminHeaders }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ seeded: 3, llmCalls: 0 });
    expect([...kv.store.keys()].filter((key) => key.startsWith('summary:'))).toHaveLength(3);
  });

  it('lists demo examples publicly', async () => {
    const res = await app.request('/v1/demo/examples', {}, makeEnv());
    expect(res.status).toBe(200);
    const data = (await res.json()) as { examples: Array<{ label: string }> };
    expect(data.examples).toHaveLength(3);
    expect(data.examples[0]?.label).toBe('CDNs');
  });

  it('submits a demo job and caps daily usage', async () => {
    const dailyKey = `demo:daily:${new Date().toISOString().slice(0, 10)}`;
    const kv = createMockKv({ [dailyKey]: '20' });
    const env = makeEnv({ CACHE: kv as unknown as ReturnType<typeof makeEnv>['CACHE'] });
    const res = await app.request(
      '/v1/demo/jobs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'CDNs' }),
      },
      env,
    );
    expect(res.status).toBe(429);
    expect(submitJob).not.toHaveBeenCalled();
  });
});
