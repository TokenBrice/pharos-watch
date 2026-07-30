-- rollout-safety: backward-compatible
-- tape_events: materialized event stream projected from existing producer
-- tables (depeg_events, blacklist_events, safety_grade_history in v1).
-- Idempotent on (source_table, source_row_id, transition) so the projector
-- can re-run safely; INSERT OR REPLACE keeps re-classification in place.
CREATE TABLE IF NOT EXISTS tape_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,            -- wire id: "${ts_ms}-${type}-${hash8}"
  type TEXT NOT NULL,                -- dot-namespaced slug
  severity TEXT NOT NULL,            -- info | notice | warning | severe | critical
  ts INTEGER NOT NULL,               -- epoch ms
  ends_at INTEGER,                   -- epoch ms; NULL when N/A
  coin_id TEXT,                      -- canonical ticker-issuer; NULL for cross-cutting events
  issuer_id TEXT,                    -- derived at projection
  peg_currency TEXT,
  chain TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_row_id TEXT NOT NULL,
  transition TEXT NOT NULL,          -- opened | updated | resolved | snapshot
  source_url TEXT,
  methodology_version TEXT,
  created_at INTEGER NOT NULL,       -- epoch sec
  CONSTRAINT tape_events_severity_chk
    CHECK (severity IN ('info','notice','warning','severe','critical'))
);

CREATE INDEX IF NOT EXISTS idx_tape_ts ON tape_events(ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tape_type_ts ON tape_events(type, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tape_coin_ts ON tape_events(coin_id, ts DESC, id DESC)
  WHERE coin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tape_issuer_ts ON tape_events(issuer_id, ts DESC, id DESC)
  WHERE issuer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tape_severity_ts ON tape_events(severity, ts DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tape_event_id ON tape_events(event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tape_source_key
  ON tape_events(source_table, source_row_id, transition);
