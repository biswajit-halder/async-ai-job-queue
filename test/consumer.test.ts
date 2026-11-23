import type { MessageBatch } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../src/db/queries';
import { InvalidContentError, QuotaExceededError, UpstreamError } from '../src/lib/errors';
import { queue, scheduled } from '../src/index';
import { processJob } from '../src/services/processor';
import { deliverCallback } from '../src/services/webhook';
import { jobMessage, jobRow, makeEnv } from './helpers';

vi.mock('../src/db/queries', () => ({
  failJob: vi.fn(),
  listQuotaFailures: vi.fn(),
  requeueJob: vi.fn(),
  toJobMessage: vi.fn(),
  // imported by route modules when index.ts loads
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
vi.mock('../src/services/processor', () => ({ processJob: vi.fn() }));
vi.mock('../src/services/webhook', () => ({ deliverCallback: vi.fn() }));

function batchFor(body: ReturnType<typeof jobMessage>, attempts = 0) {
  const ack = vi.fn();
  const retry = vi.fn();
  const batch = {
    messages: [{ id: 'msg_1', body, attempts, timestamp: new Date(), ack, retry }],
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as MessageBatch<ReturnType<typeof jobMessage>>;
  return { batch, ack, retry };
}

beforeEach(() => {
  vi.mocked(processJob).mockResolvedValue({
    action: 'completed',
    cache: 'MISS',
    model: 'm1:free',
    promptTokens: 10,
    completionTokens: 5,
  });
  vi.mocked(db.failJob).mockResolvedValue(undefined);
  vi.mocked(db.listQuotaFailures).mockResolvedValue([]);
  vi.mocked(db.requeueJob).mockResolvedValue(undefined);
  vi.mocked(deliverCallback).mockResolvedValue(true);
});

describe('queue consumer', () => {
  it('acks a completed job', async () => {
    const { batch, ack, retry } = batchFor(jobMessage());
    await queue(batch, makeEnv());
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(db.failJob).not.toHaveBeenCalled();
  });

  it('retries a transient failure with backoff', async () => {
    vi.mocked(processJob).mockRejectedValue(new UpstreamError('network blip'));
    const { batch, ack, retry } = batchFor(jobMessage(), 1);
    await queue(batch, makeEnv());
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 2 });
    expect(ack).not.toHaveBeenCalled();
    expect(db.failJob).toHaveBeenCalledWith(
      expect.anything(),
      'job_1',
      expect.stringContaining('UPSTREAM_ERROR'),
      false,
    );
  });

  it('acks and dead-letters a permanent content error', async () => {
    vi.mocked(processJob).mockRejectedValue(new InvalidContentError('no text'));
    const { batch, ack, retry } = batchFor(jobMessage());
    await queue(batch, makeEnv());
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(db.failJob).toHaveBeenCalledWith(
      expect.anything(),
      'job_1',
      expect.stringContaining('INVALID_CONTENT'),
      true,
    );
  });

  it('marks quota failures for the nightly requeue instead of burning retries', async () => {
    vi.mocked(processJob).mockRejectedValue(new QuotaExceededError());
    const { batch, ack, retry } = batchFor(jobMessage());
    await queue(batch, makeEnv());
    expect(db.failJob).toHaveBeenCalledWith(
      expect.anything(),
      'job_1',
      expect.stringContaining('QUOTA_EXCEEDED'),
      true,
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('dead-letters after the attempt budget is exhausted', async () => {
    vi.mocked(processJob).mockRejectedValue(new UpstreamError('still down'));
    const { batch, ack, retry } = batchFor(jobMessage(), 2);
    await queue(batch, makeEnv());
    expect(db.failJob).toHaveBeenCalledWith(expect.anything(), 'job_1', expect.any(String), true);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('sends a signed failure callback on a terminal failure', async () => {
    vi.mocked(processJob).mockRejectedValue(new InvalidContentError('bad input'));
    const { batch } = batchFor(
      jobMessage({ callbackUrl: 'https://hook.test', callbackSecret: 'a-long-secret' }),
    );
    await queue(batch, makeEnv());
    expect(deliverCallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverCallback).mock.calls[0]![2].status).toBe('dead_letter');
  });
});

describe('scheduled requeue', () => {
  it('requeues only quota failures and puts them back on the queue', async () => {
    const job = jobRow({ status: 'failed', error: 'QUOTA_EXCEEDED: no credits' });
    vi.mocked(db.listQuotaFailures).mockResolvedValue([job]);
    vi.mocked(db.toJobMessage).mockReturnValue(jobMessage());
    const env = makeEnv();

    await scheduled({} as never, env, {} as never);

    expect(db.listQuotaFailures).toHaveBeenCalledWith(env, 10);
    expect(db.requeueJob).toHaveBeenCalledWith(env, job.id);
    expect(env.JOBS.send).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there are no quota failures', async () => {
    const env = makeEnv();
    await scheduled({} as never, env, {} as never);
    expect(db.requeueJob).not.toHaveBeenCalled();
    expect(env.JOBS.send).not.toHaveBeenCalled();
  });
});
