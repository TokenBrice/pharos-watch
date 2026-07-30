-- rollout-safety: backward-compatible
-- Link the APXUSD below-peg reopen to its already-sealed DDR incident.
--
-- Event 90089 reopened about 31 minutes after event 90055 closed. DDR groups
-- same-coin/same-direction reopens inside 6h into the same canonical incident,
-- but this incident already has a public prediction, so the append-only sealed
-- repair authorization path is required before changing lineage/current state.

INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id, reason, created_at, expires_at, created_by)
SELECT
  90089,
  'ddr2:e32c8186781838eac1b740a44c3b8776',
  'incident_link',
  '["event_id","incident_key"]',
  NULL,
  NULL,
  'APXUSD reopened within DDR incident merge window after sealed prediction',
  unixepoch(),
  4102444800,
  'migration-0147'
WHERE EXISTS (
    SELECT 1
    FROM depeg_events e
    WHERE e.id = 90089
      AND e.stablecoin_id = 'apxusd-apyx'
      AND e.symbol = 'apxUSD'
      AND e.direction = 'below'
      AND e.source = 'live'
      AND e.started_at = 1780671044
      AND e.ended_at IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND l.event_id = 90089
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90089
      AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0147'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0147'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90089
  AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0147'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:e32c8186781838eac1b740a44c3b8776',
  90089,
  'repair_replacement',
  a.id,
  unixepoch(),
  'sealed incident reopen linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90089
  AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0147'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = a.incident_key
      AND l.event_id = a.event_id
  );

INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id, reason, created_at, expires_at, created_by)
SELECT
  90089,
  'ddr2:e32c8186781838eac1b740a44c3b8776',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  'APXUSD reopen is the current source event for the sealed canonical incident',
  unixepoch(),
  4102444800,
  'migration-0147'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND l.event_id = 90089
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND i.current_event_id = 90055
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90089
      AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0147'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0147'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90089
  AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0147'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:e32c8186781838eac1b740a44c3b8776',
  90055,
  90089,
  'sealed incident reopen adopted as current source event',
  a.id,
  NULL,
  unixepoch(),
  'migration-0147'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90089
  AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0147'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND existing.previous_event_id = 90055
      AND existing.current_event_id = 90089
      AND existing.reason = 'sealed incident reopen adopted as current source event'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90089,
    current_started_at = 1780671044,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND current_event_id = 90055
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND l.event_id = 90089
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND r.previous_event_id = 90055
      AND r.current_event_id = 90089
      AND r.reason = 'sealed incident reopen adopted as current source event'
  );
