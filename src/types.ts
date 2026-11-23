import type { D1Database, KVNamespace, Queue } from '@cloudflare/workers-types';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  JOBS: Queue<JobMessage>;
  OPENROUTER_API_KEY: string;
  ADMIN_TOKEN: string;
  DEFAULT_MODEL: string;
  FALLBACK_MODELS: string;
  REQUEST_TIMEOUT_MS: string;
  CACHE_TTL_SECONDS: string;
  MAX_SOURCE_CHARS: string;
  MAX_FETCH_BYTES: string;
  MAX_ATTEMPTS: string;
  DEMO_DAILY_LIMIT: string;
  ALLOWED_ORIGIN: string;
}

export interface AuthContext {
  keyId: string;
  label: string;
  dailyLimit: number;
  perMinuteLimit: number;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { auth: AuthContext };
};

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'dead_letter'
  | 'cancelled';

export type JobKind = 'summary';
export type SourceType = 'url' | 'text';

/** The queue message is the delivery vehicle; D1 is the source of truth. */
export interface JobMessage {
  id: string;
  keyId: string;
  kind: JobKind;
  sourceType: SourceType;
  sourceValue: string;
  contentHash: string;
  callbackUrl?: string;
  /** Kept in the queue message only, never persisted in D1. */
  callbackSecret?: string;
  createdAt: string;
}

export interface ApiKeyRow {
  id: string;
  key_hash: string;
  key_prefix: string;
  label: string;
  daily_limit: number;
  per_minute_limit: number;
  revoked: number;
  created_at: string;
  last_used_at: string | null;
}

export interface RateRow {
  minute_start: number;
  minute_count: number;
  day_start: number;
  day_count: number;
}

export interface JobRow {
  id: string;
  api_key_id: string;
  kind: string;
  source_type: string;
  source_ref: string;
  source_payload: string | null;
  content_hash: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  callback_url: string | null;
  error: string | null;
  result_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ResultRow {
  id: string;
  job_id: string;
  summary: string;
  key_points: string;
  model: string;
  source_type: string;
  source_ref: string;
  prompt_tokens: number;
  completion_tokens: number;
  created_at: string;
}

export interface SummaryOutput {
  summary: string;
  keyPoints: string[];
}

export interface CachedSummary extends SummaryOutput {
  model: string;
  createdAt: string;
}

export interface LlmResult {
  raw: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  attempts: number;
}

export interface ProcessResult {
  action: 'completed' | 'skipped' | 'failed';
  cache: 'HIT' | 'MISS';
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  reason?: string;
}

export interface SummaryEvent {
  requests: number;
  llmCalls: number;
  cacheHits: number;
  promptTokens: number;
  completionTokens: number;
}
