-- rollout-safety: backward-compatible
CREATE TABLE IF NOT EXISTS depeg_event_provenance (
  event_id INTEGER PRIMARY KEY,
  source_kind TEXT NOT NULL,
  replay_run_id TEXT,
  replay_version TEXT,
  source_price_providers TEXT,
  quote_mode TEXT,
  peg_reference_source TEXT,
  supply_source TEXT,
  confirmation_policy TEXT,
  confirmation_point_count INTEGER,
  market_diagnostics_json TEXT,
  policy_adjustments_json TEXT,
  confidence_tier TEXT,
  audit_verdict TEXT,
  public_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES depeg_events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_depeg_event_provenance_run
  ON depeg_event_provenance(replay_run_id);

CREATE INDEX IF NOT EXISTS idx_depeg_event_provenance_audit
  ON depeg_event_provenance(audit_verdict, confidence_tier);

CREATE VIEW IF NOT EXISTS depeg_events_with_provenance AS
SELECT
  e.*,
  p.public_json AS provenance_json,
  p.confidence_tier AS provenance_confidence_tier,
  p.audit_verdict AS provenance_audit_verdict,
  p.replay_run_id AS provenance_replay_run_id,
  p.replay_version AS provenance_replay_version
FROM depeg_events e
LEFT JOIN depeg_event_provenance p ON p.event_id = e.id;
