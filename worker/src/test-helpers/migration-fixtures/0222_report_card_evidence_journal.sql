-- rollout-safety: backward-compatible
-- Diagnostic-only, immutable reserve evidence-attempt provenance. Journal rows
-- are not joined into public report cards or Safety Score facts.

CREATE TABLE IF NOT EXISTS report_card_evidence_journal (
  journal_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  lane TEXT NOT NULL CHECK (lane = 'reserve'),
  asset_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempted_at INTEGER NOT NULL CHECK (attempted_at >= 0),
  completed_at INTEGER NOT NULL CHECK (completed_at >= attempted_at),
  source_id TEXT NOT NULL,
  attempt_code TEXT NOT NULL CHECK (attempt_code IN (
    'reserve.collector.attempted',
    'reserve.collector.not-configured',
    'reserve.collector.deferred'
  )),
  admission_code TEXT NOT NULL CHECK (admission_code IN (
    'reserve.admission.accepted',
    'reserve.admission.not-evaluated',
    'reserve.admission.rejected-upstream',
    'reserve.admission.rejected-timeout',
    'reserve.admission.rejected-invalid-payload',
    'reserve.admission.rejected-schema-drift',
    'reserve.admission.rejected-stale',
    'reserve.admission.rejected-reconciliation',
    'reserve.admission.rejected-sidecar-mismatch'
  )),
  fallback_code TEXT NOT NULL CHECK (fallback_code IN (
    'reserve.fallback.not-used',
    'reserve.fallback.curated',
    'reserve.fallback.reviewed-sidecar',
    'reserve.fallback.last-known-good',
    'reserve.fallback.unavailable'
  )),
  payload_json TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0 AND payload_bytes <= 1280),
  recorded_at INTEGER NOT NULL CHECK (recorded_at >= completed_at),
  UNIQUE (lane, asset_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_report_card_evidence_journal_asset_latest
  ON report_card_evidence_journal (lane, asset_id, completed_at DESC, attempt_id DESC);

CREATE INDEX IF NOT EXISTS idx_report_card_evidence_journal_retention
  ON report_card_evidence_journal (recorded_at);
