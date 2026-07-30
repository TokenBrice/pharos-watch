-- rollout-safety: backward-compatible
-- Invalidate the accidental APXUSD duplicate DDR prediction for tail event
-- 90203 and mark its incident as a superseded alias of the canonical June 2
-- incident.
--
-- Migration 0154 linked the tail only for the pre-publication duplicate case.
-- Production later sealed a public prediction for the duplicate incident, so
-- the append-only errata and repair-authorization path is required here.

INSERT INTO depeg_resolver_prediction_errata
  (public_prediction_id, incident_key, event_id, assessment_id, reason, operator_note,
   replacement_assessment_id, replacement_row_hash, row_hash_before, created_at, created_by)
SELECT
  duplicate.id,
  duplicate.incident_key,
  duplicate.event_id,
  duplicate.assessment_id,
  'event_identity_error',
  'APXUSD tail event 90203 is part of the unresolved June 2 depeg incident; duplicate DDR prediction invalidated',
  canonical.assessment_id,
  canonical.row_hash,
  duplicate.row_hash,
  unixepoch(),
  'migration-0162'
FROM depeg_resolver_public_predictions duplicate
JOIN depeg_resolver_public_predictions canonical
  ON canonical.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
WHERE duplicate.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  AND duplicate.event_id = 90203
  AND EXISTS (
    SELECT 1
    FROM depeg_events tail
    WHERE tail.id = 90203
      AND tail.stablecoin_id = 'apxusd-apyx'
      AND tail.symbol = 'apxUSD'
      AND tail.direction = 'below'
      AND tail.source = 'live'
      AND tail.ended_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_prediction_errata existing
    WHERE existing.public_prediction_id = duplicate.id
      AND existing.reason = 'event_identity_error'
      AND existing.created_by = 'migration-0162'
  );

INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id, reason, created_at, expires_at, created_by)
SELECT
  90203,
  'ddr2:70a8e43c093e0afcdc8a37143a6849f9',
  'incident_current_update',
  '["incident_state","superseded_by_incident_key"]',
  NULL,
  errata.id,
  'Supersede accidental APXUSD duplicate incident in favor of canonical June 2 incident',
  unixepoch(),
  4102444800,
  'migration-0162'
FROM depeg_resolver_prediction_errata errata
WHERE errata.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  AND errata.event_id = 90203
  AND errata.reason = 'event_identity_error'
  AND errata.created_by = 'migration-0162'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions duplicate
    WHERE duplicate.incident_key = errata.incident_key
      AND duplicate.event_id = errata.event_id
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents duplicate_incident
    WHERE duplicate_incident.incident_key = errata.incident_key
      AND duplicate_incident.stablecoin_id = 'apxusd-apyx'
      AND duplicate_incident.current_event_id = 90203
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations existing
    WHERE existing.event_id = 90203
      AND existing.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
      AND existing.operation = 'incident_current_update'
      AND existing.created_by = 'migration-0162'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  authorization.id,
  authorization.event_id,
  authorization.incident_key,
  authorization.operation,
  unixepoch(),
  'migration-0162'
FROM depeg_resolver_event_repair_authorizations authorization
WHERE authorization.event_id = 90203
  AND authorization.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  AND authorization.operation = 'incident_current_update'
  AND authorization.created_by = 'migration-0162'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions consumption
    WHERE consumption.authorization_id = authorization.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:70a8e43c093e0afcdc8a37143a6849f9',
  90203,
  90203,
  'sealed APXUSD duplicate incident superseded by canonical June 2 incident',
  authorization.id,
  errata.id,
  unixepoch(),
  'migration-0162'
FROM depeg_resolver_event_repair_authorizations authorization
JOIN depeg_resolver_prediction_errata errata
  ON errata.id = authorization.required_erratum_id
WHERE authorization.event_id = 90203
  AND authorization.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  AND authorization.operation = 'incident_current_update'
  AND authorization.created_by = 'migration-0162'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions consumption
    WHERE consumption.authorization_id = authorization.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = authorization.incident_key
      AND existing.previous_event_id = 90203
      AND existing.current_event_id = 90203
      AND existing.reason = 'sealed APXUSD duplicate incident superseded by canonical June 2 incident'
  );

INSERT INTO depeg_resolver_incident_lineage
  (from_incident_key, to_incident_key, relation, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:70a8e43c093e0afcdc8a37143a6849f9',
  'ddr2:e32c8186781838eac1b740a44c3b8776',
  'superseded_by',
  authorization.id,
  errata.id,
  unixepoch(),
  'migration-0162'
FROM depeg_resolver_event_repair_authorizations authorization
JOIN depeg_resolver_prediction_errata errata
  ON errata.id = authorization.required_erratum_id
WHERE authorization.event_id = 90203
  AND authorization.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  AND authorization.operation = 'incident_current_update'
  AND authorization.created_by = 'migration-0162'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions consumption
    WHERE consumption.authorization_id = authorization.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_lineage existing
    WHERE existing.from_incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
      AND existing.to_incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND existing.relation = 'superseded_by'
      AND existing.created_by = 'migration-0162'
  );

UPDATE depeg_resolver_incidents
SET incident_state = 'superseded',
    superseded_by_incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776',
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  AND stablecoin_id = 'apxusd-apyx'
  AND current_event_id = 90203
  AND incident_state = 'active'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions revision
    WHERE revision.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
      AND revision.previous_event_id = 90203
      AND revision.current_event_id = 90203
      AND revision.reason = 'sealed APXUSD duplicate incident superseded by canonical June 2 incident'
      AND revision.created_by = 'migration-0162'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents canonical
    WHERE canonical.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND canonical.stablecoin_id = 'apxusd-apyx'
      AND canonical.incident_state = 'active'
  );

UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-apxusd-duplicate-prediction","payload":{}}',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot');
