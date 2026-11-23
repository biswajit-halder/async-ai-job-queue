import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaExceededError } from '../src/lib/errors';
import { setCachedSummary } from '../src/services/cache';
import { callLlm } from '../src/services/llm';
import { summarize } from '../src/services/summarizer';
import { createMockKv, llmResponse, makeEnv, SAMPLE_TEXT } from './helpers';

vi.mock('../src/services/llm', () => ({ callLlm: vi.fn() }));

const VALID = JSON.stringify({
  summary: 'A CDN serves cached content from nearby edge servers.',
  key_points: ['Edges cache content', 'Misses are fetched from the origin'],
});

beforeEach(() => {
  vi.mocked(callLlm).mockReset();
});

describe('summarize', () => {
  it('serves a cache hit with zero LLM calls', async () => {
    const kv = createMockKv();
    const env = makeEnv({ CACHE: kv as unknown as ReturnType<typeof makeEnv>['CACHE'] });
    await setCachedSummary(env, 'hash_1', {
      summary: 'Cached answer',
      keyPoints: ['one'],
      model: 'fixture:demo',
      createdAt: new Date().toISOString(),
    });

    const result = await summarize(env, 'hash_1', SAMPLE_TEXT, 'text', 'source');

    expect(result.cache).toBe('HIT');
    expect(result.output.summary).toBe('Cached answer');
    expect(result.attempts).toBe(0);
    expect(callLlm).not.toHaveBeenCalled();
  });

  it('validates structured output and stores it in the cache', async () => {
    const kv = createMockKv();
    const env = makeEnv({ CACHE: kv as unknown as ReturnType<typeof makeEnv>['CACHE'] });
    vi.mocked(callLlm).mockResolvedValue(llmResponse(VALID));

    const result = await summarize(env, 'hash_2', SAMPLE_TEXT, 'text', 'source');

    expect(result.cache).toBe('MISS');
    expect(result.output.keyPoints).toHaveLength(2);
    expect(result.promptTokens).toBe(10);
    expect(kv.store.has('summary:hash_2')).toBe(true);
    expect(callLlm).toHaveBeenCalledTimes(1);
  });

  it('retries once with a repair prompt when the first output is malformed', async () => {
    const env = makeEnv();
    vi.mocked(callLlm)
      .mockResolvedValueOnce(llmResponse('not json'))
      .mockResolvedValueOnce(llmResponse(VALID));

    const result = await summarize(env, 'hash_3', SAMPLE_TEXT, 'text', 'source');

    expect(result.output.summary).toContain('cached content');
    expect(result.attempts).toBe(2);
    expect(result.promptTokens).toBe(20);
    expect(callLlm).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callLlm).mock.calls[1]![0].messages?.[2]?.content).toBe('not json');
  });

  it('gives up after two malformed answers', async () => {
    vi.mocked(callLlm).mockResolvedValue(llmResponse('{bad}'));
    await expect(
      summarize(makeEnv(), 'hash_4', SAMPLE_TEXT, 'text', 'source'),
    ).rejects.toThrow(/schema|invalid JSON/i);
    expect(callLlm).toHaveBeenCalledTimes(2);
  });

  it('propagates quota exhaustion without retrying', async () => {
    vi.mocked(callLlm).mockRejectedValue(new QuotaExceededError());
    await expect(
      summarize(makeEnv(), 'hash_5', SAMPLE_TEXT, 'text', 'source'),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    expect(callLlm).toHaveBeenCalledTimes(1);
  });
});
