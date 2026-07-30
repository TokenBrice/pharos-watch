-- rollout-safety: backward-compatible
-- 0112: Harden self-serve API key request limits, integrity, and revocation markers.
-- Keep the original api_key_request_rate_limit table intact for old Worker
-- versions during deploy. New code writes expanded scopes to this v2 table.

CREATE TABLE IF NOT EXISTS api_key_request_rate_limit_v2 (
  scope TEXT NOT NULL CHECK (scope IN (
    'submission_ip',
    'submission_email',
    'verification_ip',
    'verification_token'
  )),
  subject_hash TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject_hash, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_api_key_request_rate_limit_v2_bucket
  ON api_key_request_rate_limit_v2(bucket_start);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_requests_verification_token_unique
  ON api_key_requests(verification_token_hash)
  WHERE verification_token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_requests_api_key_unique
  ON api_key_requests(api_key_id)
  WHERE api_key_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_self_serve_claim_api_key_unique
  ON api_key_self_serve_email_claims(api_key_id)
  WHERE api_key_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_key_self_serve_revocations (
  key_prefix TEXT PRIMARY KEY,
  api_key_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  revoked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_key_self_serve_revocations_request
  ON api_key_self_serve_revocations(request_id);
