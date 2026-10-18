-- rollout-safety: backward-compatible
-- Derived response bytes only; previous Workers continue to use cache unchanged.
CREATE TABLE IF NOT EXISTS safety_score_public_manifests (
  generation_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  manifest TEXT NOT NULL CHECK(length(CAST(manifest AS BLOB)) <= 32768),
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  PRIMARY KEY (generation_id, projection_version, payload_sha256)
);
CREATE INDEX IF NOT EXISTS idx_safety_score_public_manifests_retention
  ON safety_score_public_manifests(retired_at);
CREATE TABLE IF NOT EXISTS safety_score_public_fragments (
  generation_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL,
  payload_sha256 TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 128),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 262144),
  PRIMARY KEY (generation_id, projection_version, payload_sha256, ordinal),
  FOREIGN KEY (generation_id, projection_version, payload_sha256)
    REFERENCES safety_score_public_manifests(generation_id, projection_version, payload_sha256) ON DELETE CASCADE
);
