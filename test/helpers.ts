import { vi } from 'vitest';
import type { Env, JobMessage, JobRow } from '../src/types';

export function createMockKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    }),
    put: vi.fn(async (key: string, value: string, _options?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as Env['DB'],
    CACHE: createMockKv() as unknown as Env['CACHE'],
    JOBS: { send: vi.fn(async () => undefined) } as unknown as Env['JOBS'],
    OPENROUTER_API_KEY: 'test-key',
    ADMIN_TOKEN: 'admin-test',
    DEFAULT_MODEL: 'm1:free',
    FALLBACK_MODELS: 'm2:free,m3:free',
    REQUEST_TIMEOUT_MS: '2000',
    CACHE_TTL_SECONDS: '86400',
    MAX_SOURCE_CHARS: '12000',
    MAX_FETCH_BYTES: '2000000',
    MAX_ATTEMPTS: '3',
    DEMO_DAILY_LIMIT: '20',
    ALLOWED_ORIGIN: '*',
    ...overrides,
  };
}

export const SAMPLE_TEXT = [
  'A content delivery network is a distributed group of proxy servers placed in many ' +
    'geographic locations to serve content with low latency and high availability.',
  'Requests are routed to a nearby edge server. A cache hit is served immediately, while ' +
    'a miss is fetched from the origin, stored at the edge, and then returned to the user.',
].join('\n\n');

export function jobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job_1',
    api_key_id: 'key_1',
    kind: 'summary',
    source_type: 'text',
    source_ref: SAMPLE_TEXT.slice(0, 120),
    source_payload: SAMPLE_TEXT,
    content_hash: 'hash_1',
    status: 'queued',
    attempts: 0,
    max_attempts: 3,
    callback_url: null,
    error: null,
    result_id: null,
    created_at: '2026-11-23 00:00:00',
    updated_at: '2026-11-23 00:00:00',
    completed_at: null,
    ...overrides,
  };
}

export function jobMessage(overrides: Partial<JobMessage> = {}): JobMessage {
  return {
    id: 'job_1',
    keyId: 'key_1',
    kind: 'summary',
    sourceType: 'text',
    sourceValue: SAMPLE_TEXT,
    contentHash: 'hash_1',
    createdAt: '2026-11-23T00:00:00.000Z',
    ...overrides,
  };
}

export function llmResponse(raw: string) {
  return {
    raw,
    model: 'm1:free',
    promptTokens: 10,
    completionTokens: 5,
    latencyMs: 2,
    attempts: 1,
  };
}

export function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
