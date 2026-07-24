-- rollout-safety: backward-compatible
-- Diagnostic-only, immutable supply-attribution evidence. Rows are not joined
-- into V8 publication, V9 facts, scoring, activation, or public responses.

CREATE TABLE IF NOT EXISTS safety_score_v9_supply_attribution_journal (
  journal_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  lane TEXT NOT NULL CHECK (lane = 'supply-attribution'),
  asset_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL CHECK (attempted_at >= 0),
  completed_at INTEGER NOT NULL CHECK (completed_at >= attempted_at),
  source_id TEXT NOT NULL,
  admission_code TEXT NOT NULL CHECK (admission_code IN (
    'supply-attribution.admission.accepted',
    'supply-attribution.admission.rejected-upstream',
    'supply-attribution.admission.rejected-invalid-payload',
    'supply-attribution.admission.rejected-identity-drift',
    'supply-attribution.admission.rejected-route-inventory',
    'supply-attribution.admission.rejected-stale',
    'supply-attribution.admission.rejected-skew',
    'supply-attribution.admission.rejected-reconciliation'
  )),
  fallback_code TEXT NOT NULL CHECK (fallback_code IN (
    'supply-attribution.fallback.not-used',
    'supply-attribution.fallback.aggregate-only'
  )),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0 AND payload_bytes <= 1280),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= completed_at),
  UNIQUE (lane, asset_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_supply_attribution_journal_asset_latest
  ON safety_score_v9_supply_attribution_journal (
    lane,
    asset_id,
    completed_at DESC,
    attempt_id DESC
  );

CREATE INDEX IF NOT EXISTS idx_safety_score_v9_supply_attribution_journal_retention
  ON safety_score_v9_supply_attribution_journal (recorded_at);
