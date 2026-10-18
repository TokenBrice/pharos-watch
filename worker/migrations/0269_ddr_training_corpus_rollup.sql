-- rollout-safety: backward-compatible
-- data-migration: reviewed
-- Review metadata covers trigger-body DELETE statements; applying the DDL
-- mutates zero source/rollup rows. Only the new derived table is a DML target.
-- No migration-time corpus scan. The resolver backfills bounded pages after activation.
-- Triggers cover every writer, including the previous Worker and authorized repairs.
CREATE TABLE IF NOT EXISTS depeg_resolver_training_corpus (
  event_id INTEGER PRIMARY KEY,
  stablecoin_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  severity_observations_json TEXT NOT NULL CHECK (
    CASE WHEN json_valid(severity_observations_json)
      THEN json_type(severity_observations_json) = 'array' ELSE 0 END
  )
);

-- Keep the original aggregate and its access path: observation order is part of
-- the stored bytes, including NULL deviations and duplicate observation clocks.
CREATE VIEW IF NOT EXISTS depeg_resolver_training_observations AS
SELECT e.id AS event_id, e.stablecoin_id, e.direction, e.started_at, e.ended_at,
  (SELECT json_group_array(json_object('observedAt', a.assessed_at, 'deviationBps',
    CASE WHEN json_valid(a.row_json) THEN json_extract(a.row_json, '$.currentDeviationBps') END))
   FROM depeg_resolver_assessments a
   WHERE a.event_id = e.id AND a.stablecoin_id = e.stablecoin_id
     AND a.direction = e.direction AND a.started_at = e.started_at
     AND a.assessed_at >= e.started_at AND a.assessed_at <= e.ended_at
  ) AS severity_observations_json
FROM depeg_events e WHERE e.ended_at IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_ddr_training_event_insert
AFTER INSERT ON depeg_events
BEGIN
  DELETE FROM depeg_resolver_training_corpus WHERE event_id = NEW.id;
  INSERT INTO depeg_resolver_training_corpus
    SELECT * FROM depeg_resolver_training_observations WHERE event_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_training_event_update
AFTER UPDATE OF id, stablecoin_id, direction, started_at, ended_at ON depeg_events
BEGIN
  DELETE FROM depeg_resolver_training_corpus WHERE event_id IN (OLD.id, NEW.id);
  INSERT INTO depeg_resolver_training_corpus
    SELECT * FROM depeg_resolver_training_observations WHERE event_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_training_event_delete
AFTER DELETE ON depeg_events
BEGIN
  DELETE FROM depeg_resolver_training_corpus WHERE event_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_training_assessment_insert
AFTER INSERT ON depeg_resolver_assessments
BEGIN
  DELETE FROM depeg_resolver_training_corpus WHERE event_id = NEW.event_id;
  INSERT INTO depeg_resolver_training_corpus
    SELECT * FROM depeg_resolver_training_observations WHERE event_id = NEW.event_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_training_assessment_update
AFTER UPDATE ON depeg_resolver_assessments
BEGIN
  DELETE FROM depeg_resolver_training_corpus WHERE event_id IN (OLD.event_id, NEW.event_id);
  INSERT INTO depeg_resolver_training_corpus
    SELECT * FROM depeg_resolver_training_observations WHERE event_id IN (OLD.event_id, NEW.event_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_training_assessment_delete
AFTER DELETE ON depeg_resolver_assessments
BEGIN
  DELETE FROM depeg_resolver_training_corpus WHERE event_id = OLD.event_id;
  INSERT INTO depeg_resolver_training_corpus
    SELECT * FROM depeg_resolver_training_observations WHERE event_id = OLD.event_id;
END;

-- Both the promoted-onset join and its ambiguity guard become exact seeks,
-- rather than scanning every pending outcome for a coin for every history row.
CREATE INDEX IF NOT EXISTS idx_depeg_pending_outcomes_training_identity
  ON depeg_pending_outcomes(stablecoin_id, peg_type, direction, first_seen_at, outcome);

-- The capped history projection is index-only: avoid a second event-table read
-- for each of up to 60k selected rows. Active peak updates do not touch it.
CREATE INDEX IF NOT EXISTS idx_depeg_training_history
  ON depeg_events(started_at, id, stablecoin_id, peg_type, direction, source,
    peak_deviation_bps, ended_at, recovery_price, close_reason)
  WHERE ended_at IS NOT NULL;
