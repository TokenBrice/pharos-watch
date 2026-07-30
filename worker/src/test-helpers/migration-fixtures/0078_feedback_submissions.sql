-- rollout-safety: backward-compatible

CREATE TABLE IF NOT EXISTS feedback_submissions (
  submission_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  status TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  title TEXT,
  description TEXT NOT NULL,
  expected_value TEXT,
  stablecoin_id TEXT,
  stablecoin_name TEXT,
  page_url TEXT NOT NULL,
  peg_value TEXT,
  contact_consent INTEGER NOT NULL DEFAULT 0,
  contact_channel TEXT,
  contact_handle TEXT,
  github_target_kind TEXT,
  github_target_number INTEGER,
  github_target_url TEXT,
  last_error TEXT,
  CHECK (status IN ('pending', 'submitted', 'failed')),
  CHECK (feedback_type IN ('bug', 'data-correction', 'feature-request')),
  CHECK (contact_consent IN (0, 1)),
  CHECK (contact_channel IS NULL OR contact_channel IN ('telegram', 'x')),
  CHECK (github_target_kind IS NULL OR github_target_kind IN ('issue', 'discussion'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created_at
  ON feedback_submissions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_status_created_at
  ON feedback_submissions(status, created_at DESC);
