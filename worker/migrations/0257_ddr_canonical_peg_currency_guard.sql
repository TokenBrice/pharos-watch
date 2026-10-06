-- rollout-safety: backward-compatible
-- Replace the relational guard without removing any assessment, identity,
-- event-open, link, policy, or lock-timing predicate. shared/lib/peg-taxonomy.ts
-- defines peggedREAL and peggedBRL as BRL; retained REAL currency identities
-- are the same alias and remain compatible with the previous Worker.
-- No stored incidents, assessments, or immutable public predictions change.

DROP TRIGGER IF EXISTS trg_ddr_public_predictions_relational_guard;

CREATE TRIGGER trg_ddr_public_predictions_relational_guard
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
    AND CASE a.peg_currency WHEN 'REAL' THEN 'BRL' ELSE a.peg_currency END = CASE
      WHEN e.peg_type = 'peggedREAL' THEN 'BRL'
      WHEN e.peg_type LIKE 'pegged%' THEN substr(e.peg_type, 7)
      ELSE 'USD'
    END
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
    AND CASE i.peg_currency WHEN 'REAL' THEN 'BRL' ELSE i.peg_currency END = CASE
      WHEN e.peg_type = 'peggedREAL' THEN 'BRL'
      WHEN e.peg_type LIKE 'pegged%' THEN substr(e.peg_type, 7)
      ELSE 'USD'
    END
    AND i.direction = e.direction
)
BEGIN
  SELECT RAISE(ABORT, 'sealed prediction must reference a linked public_prediction assessment');
END;
