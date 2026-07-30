-- rollout-safety: backward-compatible
-- DDRv2 public_prediction assessment guards, sealed public predictions, and durable lock state.
CREATE INDEX IF NOT EXISTS idx_ddr_assessments_public_prediction_review
  ON depeg_resolver_assessments(assessed_at DESC, event_id)
  WHERE checkpoint = 'public_prediction';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_assessments_one_public_prediction
  ON depeg_resolver_assessments(event_id)
  WHERE checkpoint = 'public_prediction';

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_prediction_no_update
BEFORE UPDATE ON depeg_resolver_assessments
WHEN OLD.checkpoint = 'public_prediction' OR NEW.checkpoint = 'public_prediction'
BEGIN
  SELECT RAISE(ABORT, 'public_prediction assessments are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_prediction_no_delete
BEFORE DELETE ON depeg_resolver_assessments
WHEN OLD.checkpoint = 'public_prediction'
BEGIN
  SELECT RAISE(ABORT, 'public_prediction assessments are immutable');
END;

CREATE TABLE IF NOT EXISTS depeg_resolver_public_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_key TEXT NOT NULL UNIQUE CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL,
  assessment_id INTEGER NOT NULL UNIQUE,
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('prediction', 'no_call')),
  prediction_policy_version TEXT NOT NULL CHECK (length(trim(prediction_policy_version)) > 0),
  prediction_methodology_version TEXT NOT NULL CHECK (length(trim(prediction_methodology_version)) > 0),
  prediction_methodology_version_label TEXT NOT NULL CHECK (length(trim(prediction_methodology_version_label)) > 0),
  resolution_rubric_version TEXT NOT NULL CHECK (length(trim(resolution_rubric_version)) > 0),
  duration_model_version TEXT NOT NULL CHECK (length(trim(duration_model_version)) > 0),
  incident_grouping_version TEXT NOT NULL CHECK (length(trim(incident_grouping_version)) > 0),
  support_rules_version TEXT NOT NULL CHECK (length(trim(support_rules_version)) > 0),
  policy_delay_sec INTEGER NOT NULL CHECK (policy_delay_sec > 0),
  eligible_at INTEGER NOT NULL,
  locked_at INTEGER NOT NULL,
  event_age_at_lock_sec INTEGER NOT NULL,
  lock_timing TEXT NOT NULL CHECK (lock_timing IN ('on_time', 'late_confirmation', 'late_freeze', 'deferred')),
  sealed_payload_json TEXT NOT NULL CHECK (json_valid(sealed_payload_json)),
  row_hash TEXT NOT NULL CHECK (length(row_hash) = 64 AND row_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (locked_at >= eligible_at),
  CHECK (event_age_at_lock_sec >= 0)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_prediction_lock_state (
  incident_key TEXT PRIMARY KEY CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL,
  prediction_policy_version TEXT NOT NULL CHECK (length(trim(prediction_policy_version)) > 0),
  eligible_at INTEGER NOT NULL,
  first_eligible_seen_at INTEGER,
  last_attempted_at INTEGER,
  deferral_count INTEGER NOT NULL DEFAULT 0,
  last_deferral_reason TEXT,
  last_state TEXT NOT NULL CHECK (
    last_state IN (
      'pending_lock',
      'lock_deferred',
      'frozen',
      'no_call',
      'publication_retry_pending',
      'publication_failed',
      'published'
    )
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (deferral_count >= 0),
  CHECK (first_eligible_seen_at IS NULL OR first_eligible_seen_at >= eligible_at),
  CHECK (last_attempted_at IS NULL OR last_attempted_at >= eligible_at)
);

CREATE TABLE IF NOT EXISTS depeg_resolver_lock_opportunity_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_key TEXT NOT NULL CHECK (length(trim(incident_key)) > 0),
  event_id INTEGER NOT NULL,
  run_id TEXT,
  run_at INTEGER NOT NULL CHECK (run_at > 0),
  eligible_at INTEGER NOT NULL,
  health_status TEXT NOT NULL CHECK (health_status IN ('healthy', 'degraded', 'skipped')),
  action TEXT NOT NULL CHECK (
    action IN (
      'pending',
      'deferred',
      'confirmed_seen',
      'locked_prediction',
      'locked_no_call',
      'publication_retry_pending',
      'publication_failed',
      'published'
    )
  ),
  confirmation_at INTEGER,
  outcome_at INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL CHECK (created_at > 0)
);

CREATE INDEX IF NOT EXISTS idx_ddr_public_predictions_event
  ON depeg_resolver_public_predictions(event_id);

CREATE INDEX IF NOT EXISTS idx_ddr_public_predictions_assessment
  ON depeg_resolver_public_predictions(assessment_id);

CREATE INDEX IF NOT EXISTS idx_ddr_lock_state_state
  ON depeg_resolver_prediction_lock_state(last_state, eligible_at);

CREATE INDEX IF NOT EXISTS idx_ddr_lock_opportunity_incident
  ON depeg_resolver_lock_opportunity_audit(incident_key, run_at);

CREATE INDEX IF NOT EXISTS idx_ddr_lock_opportunity_event
  ON depeg_resolver_lock_opportunity_audit(event_id, run_at);

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_no_update
BEFORE UPDATE ON depeg_resolver_public_predictions
BEGIN
  SELECT RAISE(ABORT, 'sealed public predictions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_no_delete
BEFORE DELETE ON depeg_resolver_public_predictions
BEGIN
  SELECT RAISE(ABORT, 'sealed public predictions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_assessment_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_assessments a
  JOIN depeg_events e
    ON e.id = NEW.event_id
  JOIN depeg_resolver_incident_event_links l
    ON l.incident_key = NEW.incident_key
   AND l.event_id = NEW.event_id
  JOIN depeg_resolver_incidents i
    ON i.incident_key = NEW.incident_key
  JOIN depeg_resolver_incident_policy_membership m
    ON m.incident_key = NEW.incident_key
  WHERE a.id = NEW.assessment_id
    AND a.event_id = NEW.event_id
    AND a.checkpoint = 'public_prediction'
    AND a.methodology_version = NEW.prediction_methodology_version
    AND a.methodology_version_label = NEW.prediction_methodology_version_label
    AND a.resolution_rubric_version = NEW.resolution_rubric_version
    AND a.duration_model_version = NEW.duration_model_version
    AND a.incident_grouping_version = NEW.incident_grouping_version
    AND a.support_rules_version = NEW.support_rules_version
    AND json_valid(a.row_json)
    AND json_valid(a.horizons_json)
    AND json_valid(a.factors_json)
    AND a.assessed_at = NEW.locked_at
    AND a.stablecoin_id = e.stablecoin_id
    AND a.peg_currency = CASE WHEN e.peg_type LIKE 'pegged%' THEN substr(e.peg_type, 7) ELSE 'USD' END
    AND a.direction = e.direction
    AND a.started_at = e.started_at
    AND a.event_age_sec = NEW.event_age_at_lock_sec
    AND e.ended_at IS NULL
    AND i.current_event_id = NEW.event_id
    AND l.relation IN ('observed', 'repair_replacement')
    AND m.policy_universe_included = 1
    AND m.prediction_policy_version = NEW.prediction_policy_version
    AND NEW.event_age_at_lock_sec = NEW.locked_at - e.started_at
    AND NEW.eligible_at = e.started_at + NEW.policy_delay_sec
    AND i.stablecoin_id = e.stablecoin_id
    AND i.peg_currency = CASE WHEN e.peg_type LIKE 'pegged%' THEN substr(e.peg_type, 7) ELSE 'USD' END
    AND i.direction = e.direction
    AND json_extract(a.row_json, '$.eventId') = NEW.event_id
    AND json_extract(a.row_json, '$.incidentKey') = NEW.incident_key
    AND json_extract(a.row_json, '$.stablecoinId') = i.stablecoin_id
    AND json_extract(a.row_json, '$.pegCurrency') = i.peg_currency
    AND json_extract(a.row_json, '$.direction') = i.direction
    AND json_extract(a.row_json, '$.startedAt') = i.current_started_at
    AND json_extract(a.row_json, '$.prediction.eligibleAt') = NEW.eligible_at
    AND json_extract(a.row_json, '$.prediction.lockedAt') = NEW.locked_at
    AND json_extract(a.row_json, '$.prediction.eventAgeAtLockSec') = NEW.event_age_at_lock_sec
    AND json_extract(a.row_json, '$.prediction.lockTiming') = NEW.lock_timing
    AND json_extract(a.row_json, '$.prediction.policyDelaySec') = NEW.policy_delay_sec
    AND json_extract(a.row_json, '$.prediction.predictionPolicyVersion') = NEW.prediction_policy_version
    AND json_extract(a.row_json, '$.prediction.predictionMethodologyVersion') = NEW.prediction_methodology_version
    AND json_extract(a.row_json, '$.prediction.resolutionRubricVersion') = NEW.resolution_rubric_version
    AND json_extract(a.row_json, '$.prediction.durationModelVersion') = NEW.duration_model_version
    AND json_extract(a.row_json, '$.prediction.incidentGroupingVersion') = NEW.incident_grouping_version
    AND json_extract(a.row_json, '$.prediction.supportRulesVersion') = NEW.support_rules_version
    AND (
      (NEW.outcome_kind = 'prediction' AND json_extract(a.row_json, '$.kind') = 'prediction')
      OR (
        NEW.outcome_kind = 'no_call'
        AND json_extract(a.row_json, '$.kind') = 'no_call'
        AND a.resolution_tier = 'insufficient_signal'
        AND a.duration_suppressed = 1
        AND a.duration_suppressed_reason = 'insufficient_signal'
        AND a.median_remaining_sec IS NULL
        AND a.iqr_low_remaining_sec IS NULL
        AND a.iqr_high_remaining_sec IS NULL
        AND a.stratum IS NULL
        AND a.horizons_json = '[]'
        AND a.factors_json = '[]'
      )
    )
    AND json_extract(a.row_json, '$.prediction.rowHash') = NEW.row_hash
    AND NEW.sealed_payload_json = a.row_json
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction must reference a linked public_prediction assessment');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_opportunity_no_update
BEFORE UPDATE ON depeg_resolver_lock_opportunity_audit
BEGIN
  SELECT RAISE(ABORT, 'lock opportunity audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_opportunity_no_delete
BEFORE DELETE ON depeg_resolver_lock_opportunity_audit
BEGIN
  SELECT RAISE(ABORT, 'lock opportunity audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_no_delete
BEFORE DELETE ON depeg_resolver_prediction_lock_state
BEGIN
  SELECT RAISE(ABORT, 'lock state is durable and cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_preseal_transition_guard
BEFORE UPDATE OF incident_key, event_id, prediction_policy_version, eligible_at, first_eligible_seen_at, deferral_count, last_state, created_at
ON depeg_resolver_prediction_lock_state
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
AND NOT (
  NEW.incident_key = OLD.incident_key
  AND NEW.event_id = OLD.event_id
  AND NEW.prediction_policy_version = OLD.prediction_policy_version
  AND NEW.eligible_at = OLD.eligible_at
  AND (OLD.first_eligible_seen_at IS NULL OR NEW.first_eligible_seen_at = OLD.first_eligible_seen_at)
  AND (OLD.last_attempted_at IS NULL OR NEW.last_attempted_at IS NULL OR NEW.last_attempted_at >= OLD.last_attempted_at)
  AND NEW.deferral_count >= OLD.deferral_count
  AND (
    (OLD.last_state = 'pending_lock' AND NEW.last_state IN ('pending_lock', 'lock_deferred', 'frozen', 'no_call'))
    OR (OLD.last_state = 'lock_deferred' AND NEW.last_state IN ('lock_deferred', 'frozen', 'no_call'))
    OR (OLD.last_state = 'frozen' AND NEW.last_state IN ('frozen', 'publication_retry_pending', 'published'))
    OR (OLD.last_state = 'no_call' AND NEW.last_state IN ('no_call', 'publication_retry_pending', 'published'))
    OR (OLD.last_state = 'publication_retry_pending' AND NEW.last_state IN ('publication_retry_pending', 'published', 'publication_failed'))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'pre-seal lock-state transition is not allowed');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_sealed_fields_no_update
BEFORE UPDATE OF incident_key, prediction_policy_version, eligible_at, created_at
ON depeg_resolver_prediction_lock_state
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
BEGIN
  SELECT RAISE(ABORT, 'sealed lock-state identity fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_sealed_transition_guard
BEFORE UPDATE OF event_id, last_state, deferral_count, last_deferral_reason
ON depeg_resolver_prediction_lock_state
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
AND NOT (
  NEW.event_id = OLD.event_id
  AND NEW.deferral_count = OLD.deferral_count
  AND COALESCE(NEW.last_deferral_reason, '') = COALESCE(OLD.last_deferral_reason, '')
  AND OLD.last_state IN ('frozen', 'no_call', 'publication_retry_pending', 'publication_failed')
  AND NEW.last_state IN ('publication_retry_pending', 'publication_failed', 'published')
  AND NOT (OLD.last_state = 'publication_failed' AND NEW.last_state != 'publication_failed')
)
BEGIN
  SELECT RAISE(ABORT, 'sealed lock-state may only transition through retry, final failure, or published');
END;
