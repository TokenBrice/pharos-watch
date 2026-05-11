-- rollout-safety: backward-compatible
-- 0110: Add email-verified self-serve API key request metadata,
-- request throttles, and per-email issuance claims.

CREATE TABLE IF NOT EXISTS api_key_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  api_key_id INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'pending_verification',
    'issued',
    'rejected',
    'blocked',
    'expired'
  )),
  normalized_email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  requester_name TEXT,
  organization TEXT,
  project_url TEXT,
  use_case TEXT NOT NULL,
  intended_endpoints_json TEXT,
  expected_cadence TEXT,
  expected_volume TEXT,
  accepted_terms INTEGER NOT NULL DEFAULT 0,
  self_serve_rate_limit_per_minute INTEGER NOT NULL,
  self_serve_expires_at INTEGER,
  ip_hash TEXT NOT NULL,
  user_agent_hash TEXT,
  honeypot_triggered INTEGER NOT NULL DEFAULT 0,
  risk_score INTEGER NOT NULL DEFAULT 0,
  risk_reasons_json TEXT,
  verification_token_hash TEXT,
  verification_sent_at INTEGER,
  verification_expires_at INTEGER,
  email_provider_message_id TEXT,
  issued_at INTEGER,
  rejected_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_email_status
  ON api_key_requests(email_hash, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_ip_created
  ON api_key_requests(ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_api_key
  ON api_key_requests(api_key_id);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_status_created
  ON api_key_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_requests_verification_token
  ON api_key_requests(verification_token_hash);

CREATE TABLE IF NOT EXISTS api_key_request_rate_limit (
  scope TEXT NOT NULL CHECK (scope IN ('ip', 'email', 'token')),
  subject_hash TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject_hash, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_api_key_request_rate_limit_bucket
  ON api_key_request_rate_limit(bucket_start);

CREATE TABLE IF NOT EXISTS api_key_self_serve_email_claims (
  email_hash TEXT PRIMARY KEY,
  normalized_email TEXT NOT NULL,
  api_key_id INTEGER,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_verification', 'issued', 'released')),
  claimed_at INTEGER NOT NULL,
  released_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_self_serve_email_claims_status
  ON api_key_self_serve_email_claims(status, updated_at DESC);
