-- rollout-safety: backward-compatible
-- Add DDR readiness/backstop lock metadata without changing legacy sticky-24h
-- rows. Null lock_trigger preserves the existing scheduled-24h policy shape.

ALTER TABLE depeg_resolver_public_predictions ADD COLUMN lock_trigger TEXT CHECK (
  lock_trigger IS NULL OR lock_trigger IN ('scheduled_24h', 'forecast_readiness', 'readiness_backstop')
);
ALTER TABLE depeg_resolver_public_predictions ADD COLUMN forecast_readiness_score REAL CHECK (
  forecast_readiness_score IS NULL OR (forecast_readiness_score >= 0 AND forecast_readiness_score <= 1)
);
ALTER TABLE depeg_resolver_public_predictions ADD COLUMN forecast_readiness_version TEXT CHECK (
  forecast_readiness_version IS NULL OR length(trim(forecast_readiness_version)) > 0
);
ALTER TABLE depeg_resolver_public_predictions ADD COLUMN readiness_threshold REAL CHECK (
  readiness_threshold IS NULL OR (readiness_threshold >= 0 AND readiness_threshold <= 1)
);
ALTER TABLE depeg_resolver_public_predictions ADD COLUMN backstop_at INTEGER CHECK (
  backstop_at IS NULL OR backstop_at > 0
);
ALTER TABLE depeg_resolver_public_predictions ADD COLUMN backstop_delay_sec INTEGER CHECK (
  backstop_delay_sec IS NULL OR backstop_delay_sec >= 0
);

ALTER TABLE depeg_resolver_prediction_lock_state ADD COLUMN lock_trigger TEXT CHECK (
  lock_trigger IS NULL OR lock_trigger IN ('scheduled_24h', 'forecast_readiness', 'readiness_backstop')
);
ALTER TABLE depeg_resolver_prediction_lock_state ADD COLUMN forecast_readiness_score REAL CHECK (
  forecast_readiness_score IS NULL OR (forecast_readiness_score >= 0 AND forecast_readiness_score <= 1)
);
ALTER TABLE depeg_resolver_prediction_lock_state ADD COLUMN forecast_readiness_version TEXT CHECK (
  forecast_readiness_version IS NULL OR length(trim(forecast_readiness_version)) > 0
);
ALTER TABLE depeg_resolver_prediction_lock_state ADD COLUMN readiness_threshold REAL CHECK (
  readiness_threshold IS NULL OR (readiness_threshold >= 0 AND readiness_threshold <= 1)
);
ALTER TABLE depeg_resolver_prediction_lock_state ADD COLUMN backstop_at INTEGER CHECK (
  backstop_at IS NULL OR backstop_at > 0
);
ALTER TABLE depeg_resolver_prediction_lock_state ADD COLUMN backstop_delay_sec INTEGER CHECK (
  backstop_delay_sec IS NULL OR backstop_delay_sec >= 0
);

ALTER TABLE depeg_resolver_lock_opportunity_audit ADD COLUMN lock_trigger TEXT CHECK (
  lock_trigger IS NULL OR lock_trigger IN ('scheduled_24h', 'forecast_readiness', 'readiness_backstop')
);
ALTER TABLE depeg_resolver_lock_opportunity_audit ADD COLUMN forecast_readiness_score REAL CHECK (
  forecast_readiness_score IS NULL OR (forecast_readiness_score >= 0 AND forecast_readiness_score <= 1)
);
ALTER TABLE depeg_resolver_lock_opportunity_audit ADD COLUMN forecast_readiness_version TEXT CHECK (
  forecast_readiness_version IS NULL OR length(trim(forecast_readiness_version)) > 0
);
ALTER TABLE depeg_resolver_lock_opportunity_audit ADD COLUMN readiness_threshold REAL CHECK (
  readiness_threshold IS NULL OR (readiness_threshold >= 0 AND readiness_threshold <= 1)
);
ALTER TABLE depeg_resolver_lock_opportunity_audit ADD COLUMN backstop_at INTEGER CHECK (
  backstop_at IS NULL OR backstop_at > 0
);
ALTER TABLE depeg_resolver_lock_opportunity_audit ADD COLUMN backstop_delay_sec INTEGER CHECK (
  backstop_delay_sec IS NULL OR backstop_delay_sec >= 0
);

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_lock_policy_guard
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT EXISTS (
  SELECT 1
  FROM depeg_events e
  WHERE e.id = NEW.event_id
    AND (
      (
        (NEW.lock_trigger IS NULL OR NEW.lock_trigger = 'scheduled_24h')
        AND NEW.eligible_at = e.started_at + NEW.policy_delay_sec
      )
      OR (
        NEW.lock_trigger = 'forecast_readiness'
        AND NEW.forecast_readiness_score IS NOT NULL
        AND NEW.forecast_readiness_version IS NOT NULL
        AND NEW.readiness_threshold IS NOT NULL
        AND NEW.eligible_at = e.started_at + NEW.policy_delay_sec
        AND (
          NEW.backstop_at IS NULL
          OR (
            NEW.backstop_delay_sec IS NOT NULL
            AND NEW.backstop_delay_sec = 259200
            AND NEW.backstop_at = e.started_at + NEW.backstop_delay_sec
          )
        )
      )
      OR (
        NEW.lock_trigger = 'readiness_backstop'
        AND NEW.backstop_at IS NOT NULL
        AND NEW.backstop_delay_sec IS NOT NULL
        AND NEW.backstop_delay_sec = 259200
        AND NEW.backstop_at = e.started_at + NEW.backstop_delay_sec
        AND NEW.eligible_at = NEW.backstop_at
        AND NEW.policy_delay_sec = NEW.backstop_delay_sec
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction lock policy metadata is inconsistent');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_public_predictions_payload_lock_metadata_match
BEFORE INSERT ON depeg_resolver_public_predictions
WHEN NOT (
  (
    NEW.lock_trigger IS json_extract(NEW.sealed_payload_json, '$.prediction.lockTrigger')
    OR (
      (NEW.lock_trigger IS NULL OR NEW.lock_trigger = 'scheduled_24h')
      AND json_extract(NEW.sealed_payload_json, '$.prediction.lockTrigger') IS NULL
    )
    OR (
      NEW.lock_trigger IS NULL
      AND json_extract(NEW.sealed_payload_json, '$.prediction.lockTrigger') = 'scheduled_24h'
    )
  )
  AND NEW.forecast_readiness_score IS json_extract(NEW.sealed_payload_json, '$.prediction.readiness.score')
  AND NEW.forecast_readiness_version IS json_extract(NEW.sealed_payload_json, '$.prediction.readiness.version')
  AND NEW.readiness_threshold IS json_extract(NEW.sealed_payload_json, '$.prediction.readiness.threshold')
  AND NEW.backstop_at IS json_extract(NEW.sealed_payload_json, '$.prediction.backstop.backstopAt')
  AND NEW.backstop_delay_sec IS json_extract(NEW.sealed_payload_json, '$.prediction.backstop.delaySec')
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction lock metadata does not match payload');
END;

CREATE TRIGGER IF NOT EXISTS trg_ddr_lock_state_sealed_policy_metadata_no_update
BEFORE UPDATE OF lock_trigger, forecast_readiness_score, forecast_readiness_version, readiness_threshold, backstop_at, backstop_delay_sec
ON depeg_resolver_prediction_lock_state
WHEN EXISTS (
  SELECT 1
  FROM depeg_resolver_public_predictions p
  WHERE p.incident_key = OLD.incident_key
)
AND NOT (
  NEW.lock_trigger IS OLD.lock_trigger
  AND NEW.forecast_readiness_score IS OLD.forecast_readiness_score
  AND NEW.forecast_readiness_version IS OLD.forecast_readiness_version
  AND NEW.readiness_threshold IS OLD.readiness_threshold
  AND NEW.backstop_at IS OLD.backstop_at
  AND NEW.backstop_delay_sec IS OLD.backstop_delay_sec
)
BEGIN
  SELECT RAISE(ABORT, 'sealed lock-state policy metadata is immutable');
END;
