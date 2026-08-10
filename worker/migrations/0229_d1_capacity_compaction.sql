-- rollout-safety: backward-compatible
-- Add compact DDR publication storage and a daily tier for older yield history.
-- Existing readers and writers remain valid until the corresponding Worker release.

CREATE TABLE IF NOT EXISTS depeg_resolver_publication_snapshots_v2 (
  snapshot_token TEXT PRIMARY KEY CHECK (length(trim(snapshot_token)) > 0),
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind = 'ddr_public'),
  snapshot_sequence INTEGER NOT NULL UNIQUE CHECK (snapshot_sequence > 0),
  snapshot_generation INTEGER NOT NULL CHECK (snapshot_generation > 0),
  published_at INTEGER NOT NULL CHECK (published_at > 0),
  base_payload_hash TEXT NOT NULL CHECK (length(base_payload_hash) = 64 AND base_payload_hash NOT GLOB '*[^0-9a-f]*'),
  public_prediction_ids_hash TEXT NOT NULL CHECK (length(public_prediction_ids_hash) = 64 AND public_prediction_ids_hash NOT GLOB '*[^0-9a-f]*'),
  public_prediction_ids_json TEXT NOT NULL CHECK (json_valid(public_prediction_ids_json)),
  public_prediction_row_hashes_json TEXT NOT NULL CHECK (json_valid(public_prediction_row_hashes_json)),
  base_payload_gzip BLOB NOT NULL,
  base_payload_bytes INTEGER NOT NULL CHECK (base_payload_bytes > 0),
  compressed_payload_bytes INTEGER NOT NULL CHECK (compressed_payload_bytes > 0),
  base_row_count INTEGER NOT NULL CHECK (base_row_count >= 0),
  public_prediction_count INTEGER NOT NULL CHECK (public_prediction_count >= 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  finalized_at INTEGER NOT NULL CHECK (finalized_at > 0),
  validator_version TEXT NOT NULL CHECK (length(trim(validator_version)) > 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_first_publications_v2 (
  public_prediction_id INTEGER PRIMARY KEY,
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  snapshot_token TEXT NOT NULL,
  snapshot_sequence INTEGER NOT NULL CHECK (snapshot_sequence > 0),
  snapshot_generation INTEGER NOT NULL CHECK (snapshot_generation > 0),
  published_at INTEGER NOT NULL CHECK (published_at > 0),
  finalized_at INTEGER NOT NULL CHECK (finalized_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_ddr_publication_snapshots_v2_latest
  ON depeg_resolver_publication_snapshots_v2(snapshot_sequence DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_first_publications_v2_incident
  ON depeg_resolver_first_publications_v2(incident_key, public_prediction_id);

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshots_v2_no_update
BEFORE UPDATE ON depeg_resolver_publication_snapshots_v2
BEGIN
  SELECT RAISE(ABORT, 'compressed publication snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_publication_snapshots_v2_no_delete
BEFORE DELETE ON depeg_resolver_publication_snapshots_v2
BEGIN
  SELECT RAISE(ABORT, 'compressed publication snapshots are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_first_publications_v2_no_update
BEFORE UPDATE ON depeg_resolver_first_publications_v2
BEGIN
  SELECT RAISE(ABORT, 'first-publication memberships are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_first_publications_v2_no_delete
BEFORE DELETE ON depeg_resolver_first_publications_v2
BEGIN
  SELECT RAISE(ABORT, 'first-publication memberships are append-only');
END;

CREATE TABLE IF NOT EXISTS yield_history_daily (
  stablecoin_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  snapshot_date INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  is_best INTEGER NOT NULL DEFAULT 0,
  apy REAL NOT NULL,
  apy_base REAL,
  apy_reward REAL,
  exchange_rate REAL,
  source_tvl_usd REAL,
  data_source TEXT NOT NULL,
  warning_signals TEXT,
  yield_source TEXT,
  yield_type TEXT,
  publication_generation_id TEXT,
  publication_state TEXT,
  pys_at_publish REAL,
  safety_at_publish REAL,
  variance_at_publish REAL,
  pys_inputs_at_publish TEXT,
  PRIMARY KEY (stablecoin_id, source_key, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_yield_history_daily_coin_date
  ON yield_history_daily(stablecoin_id, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_yield_history_daily_date
  ON yield_history_daily(snapshot_date ASC);

CREATE TABLE IF NOT EXISTS stress_signal_publication_rows (
  stablecoin_id TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  PRIMARY KEY (stablecoin_id, computed_at)
);

CREATE INDEX IF NOT EXISTS idx_stress_signal_publication_generation
  ON stress_signal_publication_rows(computed_at DESC, stablecoin_id);

-- Preserve the generation already named by the public pointer before the new
-- Worker switches readers to this exact, bounded publication buffer. Prefer
-- the hot latest table, with the existing history table as a compatibility
-- fallback for rows not present there.
INSERT OR IGNORE INTO stress_signal_publication_rows (
  stablecoin_id, computed_at, score, band, signals_json
)
SELECT latest.stablecoin_id, latest.computed_at, latest.score, latest.band, latest.signals_json
  FROM stress_signals_latest latest
  JOIN cache pointer
    ON pointer.key = 'dews:published-generation'
 WHERE json_valid(pointer.value)
   AND latest.computed_at = CAST(json_extract(pointer.value, '$.updatedAt') AS INTEGER);

INSERT OR IGNORE INTO stress_signal_publication_rows (
  stablecoin_id, computed_at, score, band, signals_json
)
SELECT history.stablecoin_id, history.computed_at, history.score, history.band, history.signals_json
  FROM stress_signals history
  JOIN cache pointer
    ON pointer.key = 'dews:published-generation'
 WHERE json_valid(pointer.value)
   AND history.computed_at = CAST(json_extract(pointer.value, '$.updatedAt') AS INTEGER);

ALTER TABLE yield_source_decisions ADD COLUMN trend_fingerprint TEXT;
