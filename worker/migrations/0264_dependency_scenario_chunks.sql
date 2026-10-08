-- rollout-safety: backward-compatible
-- Append-only content-addressed modeled payload chunks. Legacy cache bodies and
-- latest markers stay intact; a new writer verifies chunks before committing.
CREATE TABLE IF NOT EXISTS dependency_scenario_payload_chunks (
  payload_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  value TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 32000),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  PRIMARY KEY (payload_id, chunk_index)
);
