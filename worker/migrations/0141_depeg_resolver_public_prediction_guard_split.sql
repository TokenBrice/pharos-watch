-- rollout-safety: backward-compatible
-- Split the oversized public-prediction guard so D1 can compile inserts under
-- SQLite's expression-depth limit while preserving the same append-only checks.
CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_relational_guard
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
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction must reference a linked public_prediction assessment');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_version_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_assessments a
  WHERE a.id = NEW.assessment_id
    AND a.methodology_version = NEW.prediction_methodology_version
    AND a.methodology_version_label = NEW.prediction_methodology_version_label
    AND a.resolution_rubric_version = NEW.resolution_rubric_version
    AND a.duration_model_version = NEW.duration_model_version
    AND a.incident_grouping_version = NEW.incident_grouping_version
    AND a.support_rules_version = NEW.support_rules_version
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction assessment versions must match public prediction versions');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_payload_identity_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_assessments a
  JOIN depeg_resolver_incidents i
    ON i.incident_key = NEW.incident_key
  WHERE a.id = NEW.assessment_id
    AND json_extract(a.row_json, '$.eventId') = NEW.event_id
    AND json_extract(a.row_json, '$.incidentKey') = NEW.incident_key
    AND json_extract(a.row_json, '$.stablecoinId') = i.stablecoin_id
    AND json_extract(a.row_json, '$.pegCurrency') = i.peg_currency
    AND json_extract(a.row_json, '$.direction') = i.direction
    AND json_extract(a.row_json, '$.startedAt') = i.current_started_at
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction payload identity must match incident identity');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_payload_prediction_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_resolver_assessments a
  WHERE a.id = NEW.assessment_id
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
    AND json_extract(a.row_json, '$.prediction.rowHash') = NEW.row_hash
    AND NEW.sealed_payload_json = a.row_json
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction payload prediction fields must match public prediction fields');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_prediction_kind_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NEW.outcome_kind = 'prediction'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_assessments a
    WHERE a.id = NEW.assessment_id
      AND json_extract(a.row_json, '$.kind') = 'prediction'
  )
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction payload kind must match prediction outcome');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_no_call_kind_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NEW.outcome_kind = 'no_call'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_assessments a
    WHERE a.id = NEW.assessment_id
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
BEGIN
  SELECT RAISE(ABORT, 'sealed no-call payload kind must match insufficient-signal assessment');
END;

DROP TRIGGER IF EXISTS trg_ddr_public_predictions_assessment_guard;
