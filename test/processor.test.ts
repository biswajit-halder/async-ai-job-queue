import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../src/db/queries';
import { QuotaExceededError } from '../src/lib/errors';
import { assertPublicUrl, fetchSafe } from '../src/lib/fetch-safe';
import { extractText } from '../src/lib/extract';
import { processJob } from '../src/services/processor';
import { summarize } from '../src/services/summarizer';
import { deliverCallback } from '../src/services/webhook';
import { jobMessage, jobRow, makeEnv, SAMPLE_TEXT } from './helpers';

vi.mock('../src/db/queries', () => ({
  claimJob: vi.fn(),
  insertResult: vi.fn(),
  completeJob: vi.fn(),
  insertUsageEvent: vi.fn(),
}));
vi.mock('../src/services/summarizer', () => ({ summarize: vi.fn() }));
vi.mock('../src/services/webhook', () => ({ deliverCallback: vi.fn() }));
vi.mock('../src/lib/fetch-safe', () => ({
  assertPublicUrl: vi.fn(),
  fetchSafe: vi.fn(),
}));
vi.mock('../src/lib/extract', () => ({ extractText: vi.fn() }));

const summaryResult = {
  output: { summary: 'A short summary', keyPoints: ['point'] },
  cache: 'HIT' as const,
  model: 'm1:free',
  promptTokens: 0,
  completionTokens: 0,
  attempts: 0,
};

beforeEach(() => {
  vi.mocked(db.claimJob).mockResolvedValue({ status: 'claimed', job: jobRow() });
  vi.mocked(summarize).mockResolvedValue(summaryResult);
  vi.mocked(deliverCallback).mockResolvedValue(true);
  vi.mocked(fetchSafe).mockResolvedValue({
    body: new Uint8Array(),
    contentType: 'text/html',
    finalUrl: 'https://example.com/article',
  });
  vi.mocked(extractText).mockReturnValue({ text: SAMPLE_TEXT, truncated: false });
});

describe('processJob', () => {
  it('skips a duplicate or missing job without further work', async () => {
    vi.mocked(db.claimJob).mockResolvedValue({ status: 'done', job: jobRow() });
    const result = await processJob(makeEnv(), jobMessage(), 1);
    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('already-finished');
    expect(summarize).not.toHaveBeenCalled();
  });

  it('claims a text job, persists the result and delivers a signed callback', async () => {
    const env = makeEnv();
    const message = jobMessage({
      callbackUrl: 'https://example.com/hook',
      callbackSecret: 'a-long-shared-secret',
    });

    const result = await processJob(env, message, 1);

    expect(result.action).toBe('completed');
    expect(result.cache).toBe('HIT');
    expect(db.insertResult).toHaveBeenCalledTimes(1);
    expect(db.completeJob).toHaveBeenCalledTimes(1);
    expect(db.insertUsageEvent).toHaveBeenCalledTimes(1);
    expect(deliverCallback).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverCallback).mock.calls[0]![2].status).toBe('completed');
  });

  it('fetches and extracts a URL source before summarizing', async () => {
    const result = await processJob(
      makeEnv(),
      jobMessage({ sourceType: 'url', sourceValue: 'https://example.com/article' }),
      1,
    );
    expect(assertPublicUrl).toHaveBeenCalledWith('https://example.com/article');
    expect(fetchSafe).toHaveBeenCalledTimes(1);
    expect(extractText).toHaveBeenCalledTimes(1);
    expect(result.action).toBe('completed');
  });

  it('propagates quota exhaustion so the queue can mark it for the nightly sweep', async () => {
    vi.mocked(summarize).mockRejectedValue(new QuotaExceededError());
    await expect(processJob(makeEnv(), jobMessage(), 1)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(db.completeJob).not.toHaveBeenCalled();
  });

  it('does not fail the job when the callback endpoint is down', async () => {
    vi.mocked(deliverCallback).mockResolvedValue(false);
    const result = await processJob(makeEnv(), jobMessage({ callbackUrl: 'https://hook.test' }), 1);
    expect(result.action).toBe('completed');
    expect(db.completeJob).toHaveBeenCalledTimes(1);
  });
});
