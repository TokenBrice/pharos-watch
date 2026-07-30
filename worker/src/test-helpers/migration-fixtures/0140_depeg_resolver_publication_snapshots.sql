-- rollout-safety: backward-compatible
-- DDRv2 append-only public publication manifests and finalization guards.
CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshots (
  snapshot_token TEXT PRIMARY KEY CHECK (length(trim(snapshot_token)) > 0),
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('ddr_public')),
  snapshot_sequence INTEGER NOT NULL,
  snapshot_generation INTEGER NOT NULL,
  published_at INTEGER NOT NULL CHECK (published_at > 0),
  base_payload_hash TEXT NOT NULL CHECK (length(base_payload_hash) = 64 AND base_payload_hash NOT GLOB '*[^0-9a-f]*'),
  public_prediction_ids_hash TEXT NOT NULL CHECK (length(public_prediction_ids_hash) = 64 AND public_prediction_ids_hash NOT GLOB '*[^0-9a-f]*'),
  public_prediction_ids_json TEXT NOT NULL CHECK (json_valid(public_prediction_ids_json)),
  public_prediction_row_hashes_json TEXT NOT NULL CHECK (json_valid(public_prediction_row_hashes_json)),
  base_payload_json TEXT NOT NULL CHECK (json_valid(base_payload_json)),
  base_row_count INTEGER NOT NULL CHECK (base_row_count >= 0),
  public_prediction_count INTEGER NOT NULL CHECK (public_prediction_count >= 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshot_rows (
  snapshot_token TEXT NOT NULL,
  public_prediction_id INTEGER NOT NULL,
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  first_published INTEGER NOT NULL CHECK (first_published IN (0, 1)),
  PRIMARY KEY (snapshot_token, public_prediction_id)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshot_finalizations (
  snapshot_token TEXT PRIMARY KEY,
  finalized_at INTEGER NOT NULL CHECK (finalized_at > 0),
  validator_version TEXT NOT NULL CHECK (length(trim(validator_version)) > 0),
  validated_base_payload_hash TEXT NOT NULL CHECK (length(validated_base_payload_hash) = 64 AND validated_base_payload_hash NOT GLOB '*[^0-9a-f]*'),
  validated_public_prediction_ids_hash TEXT NOT NULL CHECK (length(validated_public_prediction_ids_hash) = 64 AND validated_public_prediction_ids_hash NOT GLOB '*[^0-9a-f]*'),
  validated_public_prediction_row_hashes_json TEXT NOT NULL CHECK (json_valid(validated_public_prediction_row_hashes_json)),
  validated_base_row_count INTEGER NOT NULL CHECK (validated_base_row_count >= 0),
  validated_public_prediction_count INTEGER NOT NULL CHECK (validated_public_prediction_count >= 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshot_errata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_token TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (
    reason IN (
      'payload_hash_mismatch',
      'row_set_mismatch',
      'row_hash_mismatch',
      'schema_invalid',
      'operator_invalidation'
    )
  ),
  superseded_by_snapshot_token TEXT,
  operator_note TEXT NOT NULL CHECK (length(trim(operator_note)) > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_publication_snapshot_sequence
  ON depeg_resolver_publication_snapshots(snapshot_kind, snapshot_sequence);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_publication_first_prediction
  ON depeg_resolver_publication_snapshot_rows(public_prediction_id)
  WHERE first_published = 1;

CREATE INDEX IF NOT EXISTS idx_ddr_publication_snapshot_errata_token
  ON depeg_resolver_publication_snapshot_errata(snapshot_token, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshots_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshots
BEGIN
  SELECT RAISE(ABORT, 'publication snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshots_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshots
BEGIN
  SELECT RAISE(ABORT, 'publication snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshot_rows
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot rows are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshot_rows
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot rows are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_finalizations_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshot_finalizations
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot finalizations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_finalizations_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshot_finalizations
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot finalizations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshot_errata_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshot_errata
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot errata are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshot_errata_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshot_errata
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot errata are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_prediction_guard
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.id = NEW.public_prediction_id
    AND p.incident_key = NEW.incident_key
)
BEGIN
  SELECT RAISE(ABORT, 'publication row must reference a sealed public prediction with matching incident_key');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_no_insert_after_finalize
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_publication_snapshot_finalizations f
  WHERE f.snapshot_token = NEW.snapshot_token
)
BEGIN
  SELECT RAISE(ABORT, 'cannot add rows to a finalized publication snapshot');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_snapshot_guard
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_publication_snapshots s
  WHERE s.snapshot_token = NEW.snapshot_token
)
BEGIN
  SELECT RAISE(ABORT, 'publication row must reference an existing publication snapshot');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_declared_set_guard
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_publication_snapshots s,
       json_each(s.public_prediction_ids_json) j
  WHERE s.snapshot_token = NEW.snapshot_token
    AND CAST(j.value AS INTEGER) = NEW.public_prediction_id
)
BEGIN
  SELECT RAISE(ABORT, 'publication row must be declared in snapshot id set');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_first_required
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NEW.first_published = 0
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_publication_snapshot_rows r
    WHERE r.public_prediction_id = NEW.public_prediction_id
  )
BEGIN
  SELECT RAISE(ABORT, 'first appearance must use first_published = 1');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_rows_no_second_first
BEFORE INSERT ON depeg_resolver_publication_snapshot_rows
WHEN NEW.first_published = 1
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_publication_snapshot_rows r
    WHERE r.public_prediction_id = NEW.public_prediction_id
  )
BEGIN
  SELECT RAISE(ABORT, 'already-published prediction cannot be first-published again');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_finalization_guard
BEFORE INSERT ON depeg_resolver_publication_snapshot_finalizations
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_publication_snapshots s
  WHERE s.snapshot_token = NEW.snapshot_token
    AND s.public_prediction_count = (
      SELECT COUNT(*)
      FROM depeg_resolver_publication_snapshot_rows r
      WHERE r.snapshot_token = NEW.snapshot_token
    )
    AND s.base_row_count = json_array_length(json_extract(s.base_payload_json, '$.rows'))
    AND s.base_payload_hash = NEW.validated_base_payload_hash
    AND s.public_prediction_ids_hash = NEW.validated_public_prediction_ids_hash
    AND s.public_prediction_row_hashes_json = NEW.validated_public_prediction_row_hashes_json
    AND s.base_row_count = NEW.validated_base_row_count
    AND s.public_prediction_count = NEW.validated_public_prediction_count
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(s.public_prediction_ids_json) expected
      WHERE NOT EXISTS (
        SELECT 1
        FROM depeg_resolver_publication_snapshot_rows r
        WHERE r.snapshot_token = s.snapshot_token
          AND r.public_prediction_id = CAST(expected.value AS INTEGER)
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_publication_snapshot_rows r
      WHERE r.snapshot_token = s.snapshot_token
        AND NOT EXISTS (
          SELECT 1
          FROM json_each(s.public_prediction_ids_json) expected
          WHERE CAST(expected.value AS INTEGER) = r.public_prediction_id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_public_predictions p
      JOIN depeg_resolver_publication_snapshot_rows r
        ON r.public_prediction_id = p.id
       AND r.snapshot_token = s.snapshot_token
      WHERE json_extract(s.public_prediction_row_hashes_json, '$."' || p.id || '"') IS NULL
         OR json_extract(s.public_prediction_row_hashes_json, '$."' || p.id || '"') != p.row_hash
    )
)
BEGIN
  SELECT RAISE(ABORT, 'publication snapshot cannot finalize until declared ids, rows, and row hashes match');
END;
