-- rollout-safety: backward-compatible
-- DDRv2 append-only prediction errata ledger.
CREATE TABLE IF NOT EXISTS depeg_resolver_prediction_errata (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_prediction_id INTEGER NOT NULL CHECK (public_prediction_id > 0),
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL CHECK (event_id > 0),
  assessment_id INTEGER NOT NULL CHECK (assessment_id > 0),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'false_positive',
      'disputed',
      'no_data',
      'event_identity_error',
      'input_corruption',
      'lifecycle_status_error',
      'implementation_bug',
      'hash_mismatch'
    )
  ),
  operator_note TEXT NOT NULL CHECK (length(trim(operator_note)) > 0),
  replacement_assessment_id INTEGER,
  replacement_row_hash TEXT CHECK (
    replacement_row_hash IS NULL OR (length(replacement_row_hash) = 64 AND replacement_row_hash NOT GLOB '*[^0-9a-f]*')
  ),
  row_hash_before TEXT CHECK (
    row_hash_before IS NULL OR (length(row_hash_before) = 64 AND row_hash_before NOT GLOB '*[^0-9a-f]*')
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  created_by TEXT NOT NULL CHECK (length(trim(created_by)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_ddr_prediction_errata_event
  ON depeg_resolver_prediction_errata(event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_prediction_errata_prediction
  ON depeg_resolver_prediction_errata(public_prediction_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ddr_prediction_errata_incident
  ON depeg_resolver_prediction_errata(incident_key, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_no_update
BEFORE UPDATE ON depeg_resolver_prediction_errata
BEGIN
  SELECT RAISE(ABORT, 'prediction errata are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_no_delete
BEFORE DELETE ON depeg_resolver_prediction_errata
BEGIN
  SELECT RAISE(ABORT, 'prediction errata are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_assessment_guard
BEFORE INSERT ON depeg_resolver_prediction_errata
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.id = NEW.public_prediction_id
    AND p.assessment_id = NEW.assessment_id
    AND p.incident_key = NEW.incident_key
    AND p.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'errata must reference a matching sealed public prediction');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_replacement_guard
BEFORE INSERT ON depeg_resolver_prediction_errata
WHEN NEW.replacement_assessment_id IS NOT NULL
  AND (
    NEW.replacement_row_hash IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM depeg_resolver_assessments a
      WHERE a.id = NEW.replacement_assessment_id
        AND a.checkpoint != 'latest'
        AND json_valid(a.row_json)
        AND (
          a.checkpoint != 'public_prediction'
          OR EXISTS (
            SELECT 1
            FROM depeg_resolver_public_predictions replacement
            WHERE replacement.assessment_id = NEW.replacement_assessment_id
              AND replacement.incident_key != NEW.incident_key
          )
        )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'replacement_assessment_id must reference immutable evidence or a different sealed incident and carry replacement_row_hash');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_prediction_errata_no_self_replacement
BEFORE INSERT ON depeg_resolver_prediction_errata
WHEN NEW.replacement_assessment_id IS NOT NULL
  AND NEW.replacement_assessment_id = NEW.assessment_id
BEGIN
  SELECT RAISE(ABORT, 'replacement_assessment_id cannot self-reference');
END;
