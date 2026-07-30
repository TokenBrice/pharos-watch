-- rollout-safety: backward-compatible
-- Durable operator review state for the monthly Yield Intelligence coverage
-- queue. Rows only suppress unchanged evidence until the next review boundary;
-- they never mutate yield configuration or promote a candidate automatically.

CREATE TABLE IF NOT EXISTS yield_coverage_review_dispositions (
  queue_item_id TEXT PRIMARY KEY CHECK (length(queue_item_id) BETWEEN 1 AND 512),
  queue_item_kind TEXT NOT NULL DEFAULT 'unknown',
  evidence_fingerprint TEXT NOT NULL DEFAULT '',
  disposition TEXT NOT NULL DEFAULT 'watch'
    CHECK (disposition IN ('accept', 'dismiss', 'intentional-gap', 'watch')),
  evidence TEXT NOT NULL DEFAULT '',
  review_owner TEXT NOT NULL DEFAULT 'unassigned',
  reviewed_at INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_at >= 0),
  next_review_at INTEGER NOT NULL DEFAULT 0 CHECK (next_review_at >= 0),
  expires_at INTEGER NOT NULL DEFAULT 0 CHECK (expires_at >= 0),
  created_at INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)
);

CREATE INDEX IF NOT EXISTS idx_yield_coverage_review_dispositions_review_window
  ON yield_coverage_review_dispositions(next_review_at, expires_at);
