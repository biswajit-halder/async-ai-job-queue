-- API keys are stored only as SHA-256 hashes; the raw key is shown once at creation.
CREATE TABLE IF NOT EXISTS api_keys (
  id               TEXT PRIMARY KEY,
  key_hash         TEXT NOT NULL UNIQUE,
  key_prefix       TEXT NOT NULL,
  label            TEXT NOT NULL,
  daily_limit      INTEGER NOT NULL DEFAULT 50,
  per_minute_limit INTEGER NOT NULL DEFAULT 20,
  revoked          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at     TEXT
);

-- One row per key holds both sliding windows so the submission check is atomic.
CREATE TABLE IF NOT EXISTS rate_counters (
  key_id       TEXT PRIMARY KEY REFERENCES api_keys(id),
  minute_start INTEGER NOT NULL,
  minute_count INTEGER NOT NULL DEFAULT 0,
  day_start    INTEGER NOT NULL,
  day_count    INTEGER NOT NULL DEFAULT 0
);

-- System of record for every job. Queue messages are only the delivery vehicle.
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  api_key_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  source_type   TEXT NOT NULL,          -- url | text
  source_ref    TEXT NOT NULL,          -- url, or a short preview for text jobs
  source_payload TEXT,                  -- full text for text jobs (needed for retry)
  content_hash  TEXT NOT NULL,
  status        TEXT NOT NULL,          -- queued|processing|completed|failed|dead_letter|cancelled
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  callback_url  TEXT,
  error         TEXT,
  result_id     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_key_created ON jobs(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_hash ON jobs(content_hash);

CREATE TABLE IF NOT EXISTS results (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  summary           TEXT NOT NULL,
  key_points        TEXT NOT NULL,      -- JSON array of strings
  model             TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  source_ref        TEXT NOT NULL,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per LLM attempt (cache hits are recorded with cache = 'HIT' and 0 tokens).
CREATE TABLE IF NOT EXISTS usage_events (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL,
  key_id            TEXT NOT NULL,
  model             TEXT NOT NULL,
  cache             TEXT NOT NULL,      -- HIT | MISS
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  attempts          INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_key_time ON usage_events(key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_job ON usage_events(job_id);
