-- rollout-safety: backward-compatible
-- Content-addressed modeled payload chunks with bounded orphan retention.
-- Legacy cache bodies/markers stay intact; verify chunks before committing.
CREATE TABLE IF NOT EXISTS dependency_scenario_payload_chunks (
  payload_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  value TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 32000),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (payload_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_dependency_scenario_chunks_retention
  ON dependency_scenario_payload_chunks (created_at, payload_id, chunk_index);
