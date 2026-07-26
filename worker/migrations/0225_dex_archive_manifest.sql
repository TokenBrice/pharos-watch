-- rollout-safety: backward-compatible
-- Add the private-R2 DEX evidence archive control plane. The foundation
-- release only records no-op mode/status telemetry; source selection, object
-- writes, and source deletion are activated by later guarded releases.

CREATE TABLE IF NOT EXISTS dex_archive_manifests (
  family TEXT NOT NULL CHECK (
    family IN (
      'measured-quote-generation',
      'measured-target-generation',
      'liquidity-generation'
    )
  ),
  generation_id TEXT NOT NULL,
  source_slot_started_at INTEGER NOT NULL CHECK (source_slot_started_at >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  object_key TEXT NOT NULL,
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  object_etag TEXT,
  row_count INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  dependency_row_count INTEGER CHECK (dependency_row_count IS NULL OR dependency_row_count >= 0),
  uncompressed_bytes INTEGER CHECK (uncompressed_bytes IS NULL OR uncompressed_bytes >= 0),
  stored_bytes INTEGER CHECK (stored_bytes IS NULL OR stored_bytes >= 0),
  uploaded_at INTEGER,
  verified_at INTEGER,
  source_deleted_at INTEGER,
  expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (family, generation_id),
  UNIQUE (object_key),
  CHECK (verified_at IS NULL OR uploaded_at IS NOT NULL),
  CHECK (source_deleted_at IS NULL OR verified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_dex_archive_manifests_backlog
  ON dex_archive_manifests (
    family,
    verified_at,
    source_deleted_at,
    source_slot_started_at,
    generation_id
  );

CREATE INDEX IF NOT EXISTS idx_dex_archive_manifests_verification
  ON dex_archive_manifests (family, uploaded_at, verified_at, last_attempt_at);

CREATE INDEX IF NOT EXISTS idx_dex_archive_manifests_prune
  ON dex_archive_manifests (source_deleted_at, family, generation_id)
  WHERE source_deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS dex_archive_manifest_dependencies (
  family TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  dependency_generation_id TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  source_deleted_at INTEGER,
  PRIMARY KEY (family, generation_id, dependency_generation_id),
  FOREIGN KEY (family, generation_id)
    REFERENCES dex_archive_manifests(family, generation_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dex_archive_dependencies_source
  ON dex_archive_manifest_dependencies (
    dependency_generation_id,
    source_deleted_at,
    family,
    generation_id
  );

CREATE TABLE IF NOT EXISTS dex_archive_family_state (
  family TEXT PRIMARY KEY CHECK (family IN ('measured-execution', 'liquidity')),
  configured_mode TEXT NOT NULL DEFAULT 'off',
  effective_mode TEXT NOT NULL DEFAULT 'off' CHECK (effective_mode IN ('off', 'shadow', 'delete')),
  config_error TEXT,
  eligible_generation_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_generation_count >= 0),
  eligible_row_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_row_count >= 0),
  eligible_logical_bytes INTEGER NOT NULL DEFAULT 0 CHECK (eligible_logical_bytes >= 0),
  verified_pending_delete_count INTEGER NOT NULL DEFAULT 0 CHECK (verified_pending_delete_count >= 0),
  oldest_eligible_at INTEGER,
  oldest_verified_pending_delete_at INTEGER,
  uploaded_object_count INTEGER NOT NULL DEFAULT 0 CHECK (uploaded_object_count >= 0),
  verified_object_count INTEGER NOT NULL DEFAULT 0 CHECK (verified_object_count >= 0),
  deleted_generation_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_generation_count >= 0),
  archived_uncompressed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (archived_uncompressed_bytes >= 0),
  archived_stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK (archived_stored_bytes >= 0),
  deleted_source_row_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_source_row_count >= 0),
  deleted_source_bytes INTEGER NOT NULL DEFAULT 0 CHECK (deleted_source_bytes >= 0),
  objects_written_24h INTEGER NOT NULL DEFAULT 0 CHECK (objects_written_24h >= 0),
  source_rows_deleted_24h INTEGER NOT NULL DEFAULT 0 CHECK (source_rows_deleted_24h >= 0),
  source_bytes_deleted_24h INTEGER NOT NULL DEFAULT 0 CHECK (source_bytes_deleted_24h >= 0),
  orphan_object_count INTEGER NOT NULL DEFAULT 0 CHECK (orphan_object_count >= 0),
  missing_object_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_object_count >= 0),
  lifecycle_drift_count INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_drift_count >= 0),
  last_upload_at INTEGER,
  last_verified_at INTEGER,
  last_delete_at INTEGER,
  last_success_at INTEGER,
  last_error_at INTEGER,
  last_error TEXT,
  last_run_at INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

INSERT INTO dex_archive_family_state (family, configured_mode, effective_mode, updated_at)
VALUES
  ('measured-execution', 'off', 'off', 0),
  ('liquidity', 'off', 'off', 0)
ON CONFLICT(family) DO NOTHING;
