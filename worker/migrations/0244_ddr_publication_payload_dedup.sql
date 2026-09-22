-- rollout-safety: backward-compatible
-- Record the content identity of every stored DDR publication payload and add a
-- reference table so an unchanged publication can cite the prior immutable
-- payload instead of storing another compressed BLOB. Existing readers and
-- writers remain valid until the corresponding Worker release.

ALTER TABLE depeg_resolver_publication_snapshots_v2
  ADD COLUMN base_payload_content_hash TEXT
  CHECK (base_payload_content_hash IS NULL
         OR (length(base_payload_content_hash) = 64 AND base_payload_content_hash NOT GLOB '*[^0-9a-f]*'));

CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshot_refs (
  snapshot_token TEXT PRIMARY KEY CHECK (length(trim(snapshot_token)) > 0),
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind = 'ddr_public'),
  snapshot_sequence INTEGER NOT NULL UNIQUE CHECK (snapshot_sequence > 0),
  snapshot_generation INTEGER NOT NULL CHECK (snapshot_generation > 0),
  published_at INTEGER NOT NULL CHECK (published_at > 0),
  base_payload_hash TEXT NOT NULL CHECK (length(base_payload_hash) = 64 AND base_payload_hash NOT GLOB '*[^0-9a-f]*'),
  base_payload_content_hash TEXT NOT NULL CHECK (length(base_payload_content_hash) = 64 AND base_payload_content_hash NOT GLOB '*[^0-9a-f]*'),
  payload_snapshot_token TEXT NOT NULL REFERENCES depeg_resolver_publication_snapshots_v2(snapshot_token),
  base_payload_clock_json TEXT NOT NULL CHECK (json_valid(base_payload_clock_json)),
  public_prediction_ids_hash TEXT NOT NULL CHECK (length(public_prediction_ids_hash) = 64 AND public_prediction_ids_hash NOT GLOB '*[^0-9a-f]*'),
  public_prediction_ids_json TEXT NOT NULL CHECK (json_valid(public_prediction_ids_json)),
  public_prediction_row_hashes_json TEXT NOT NULL CHECK (json_valid(public_prediction_row_hashes_json)),
  base_row_count INTEGER NOT NULL CHECK (base_row_count >= 0),
  public_prediction_count INTEGER NOT NULL CHECK (public_prediction_count >= 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  finalized_at INTEGER NOT NULL CHECK (finalized_at > 0),
  validator_version TEXT NOT NULL CHECK (length(trim(validator_version)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_ddr_publication_snapshot_refs_latest
  ON depeg_resolver_publication_snapshot_refs(snapshot_sequence DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_publication_snapshot_refs_payload
  ON depeg_resolver_publication_snapshot_refs(payload_snapshot_token);

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshot_refs_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshot_refs
BEGIN
  SELECT RAISE(ABORT, 'publication payload references are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshot_refs_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshot_refs
BEGIN
  SELECT RAISE(ABORT, 'publication payload references are append-only');
END;
