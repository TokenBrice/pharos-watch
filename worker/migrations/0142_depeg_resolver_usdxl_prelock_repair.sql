-- rollout-safety: backward-compatible
-- Repair the unsealed DDRv2 canonical incident for the May 29-30, 2026 USDXL
-- above-peg flap. The source depeg rows were confirmed after DDRv2 enablement
-- but before any public prediction was sealed, so they can be adopted through
-- append-only incident links and revisions. If a prediction has somehow been
-- sealed before this migration runs, every statement below no-ops and the
-- sealed repair-authorization path remains required.
--
-- Keep this as single-row statements. D1 rejected the first version's compact
-- UNION ALL helper tables during production migration application.

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90031,
  'repair_replacement',
  NULL,
  unixepoch(),
  'pre-lock nearby event adopted as current incident source'
FROM depeg_events e
WHERE e.id = 90031
  AND e.stablecoin_id = 'usdxl-last'
  AND e.direction = 'above'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90032,
  'repair_replacement',
  NULL,
  unixepoch(),
  'pre-lock nearby event adopted as current incident source'
FROM depeg_events e
WHERE e.id = 90032
  AND e.stablecoin_id = 'usdxl-last'
  AND e.direction = 'above'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90033,
  'repair_replacement',
  NULL,
  unixepoch(),
  'pre-lock nearby event adopted as current incident source'
FROM depeg_events e
WHERE e.id = 90033
  AND e.stablecoin_id = 'usdxl-last'
  AND e.direction = 'above'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90034,
  'repair_replacement',
  NULL,
  unixepoch(),
  'pre-lock nearby event adopted as current incident source'
FROM depeg_events e
WHERE e.id = 90034
  AND e.stablecoin_id = 'usdxl-last'
  AND e.direction = 'above'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90035,
  'repair_replacement',
  NULL,
  unixepoch(),
  'pre-lock nearby event adopted as current incident source'
FROM depeg_events e
WHERE e.id = 90035
  AND e.stablecoin_id = 'usdxl-last'
  AND e.direction = 'above'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90036,
  'repair_replacement',
  NULL,
  unixepoch(),
  'pre-lock nearby event adopted as current incident source'
FROM depeg_events e
WHERE e.id = 90036
  AND e.stablecoin_id = 'usdxl-last'
  AND e.direction = 'above'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90030,
  90031,
  'pre-lock nearby event adopted as current incident source',
  NULL,
  NULL,
  unixepoch(),
  'migration-0142'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND l.event_id = 90031
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND existing.previous_event_id = 90030
      AND existing.current_event_id = 90031
      AND existing.reason = 'pre-lock nearby event adopted as current incident source'
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90031,
  90032,
  'pre-lock nearby event adopted as current incident source',
  NULL,
  NULL,
  unixepoch(),
  'migration-0142'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND l.event_id = 90032
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND existing.previous_event_id = 90031
      AND existing.current_event_id = 90032
      AND existing.reason = 'pre-lock nearby event adopted as current incident source'
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90032,
  90033,
  'pre-lock nearby event adopted as current incident source',
  NULL,
  NULL,
  unixepoch(),
  'migration-0142'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND l.event_id = 90033
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND existing.previous_event_id = 90032
      AND existing.current_event_id = 90033
      AND existing.reason = 'pre-lock nearby event adopted as current incident source'
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90033,
  90034,
  'pre-lock nearby event adopted as current incident source',
  NULL,
  NULL,
  unixepoch(),
  'migration-0142'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND l.event_id = 90034
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND existing.previous_event_id = 90033
      AND existing.current_event_id = 90034
      AND existing.reason = 'pre-lock nearby event adopted as current incident source'
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90034,
  90035,
  'pre-lock nearby event adopted as current incident source',
  NULL,
  NULL,
  unixepoch(),
  'migration-0142'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND l.event_id = 90035
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND existing.previous_event_id = 90034
      AND existing.current_event_id = 90035
      AND existing.reason = 'pre-lock nearby event adopted as current incident source'
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:d85042cc0e57fe1e0c3228b8beff54b5',
  90035,
  90036,
  'pre-lock nearby event adopted as current incident source',
  NULL,
  NULL,
  unixepoch(),
  'migration-0142'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND l.event_id = 90036
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
      AND existing.previous_event_id = 90035
      AND existing.current_event_id = 90036
      AND existing.reason = 'pre-lock nearby event adopted as current incident source'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90036,
    current_started_at = (SELECT started_at FROM depeg_events WHERE id = 90036),
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  AND current_event_id = 90030
  AND EXISTS (
    SELECT 1
    FROM depeg_events e
    WHERE e.id = 90036
      AND e.stablecoin_id = 'usdxl-last'
      AND e.direction = 'above'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d85042cc0e57fe1e0c3228b8beff54b5'
  );
