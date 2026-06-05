-- rollout-safety: backward-compatible
-- Link the USDA below-peg reopen to its already-sealed DDR incident.
--
-- Event 90091 reopened inside DDR's sticky incident window after event 90078
-- had a public prediction sealed. The sealed incident repair authorization
-- path is required before changing lineage/current state.

INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id, reason, created_at, expires_at, created_by)
SELECT
  90091,
  'ddr2:b771f571c67373f4c4525039afc1a65b',
  'incident_link',
  '["event_id","incident_key"]',
  NULL,
  NULL,
  'USDA reopened within DDR incident merge window after sealed prediction',
  unixepoch(),
  4102444800,
  'migration-0148'
WHERE EXISTS (
    SELECT 1
    FROM depeg_events e
    WHERE e.id = 90091
      AND e.stablecoin_id = 'usda-alpha-partner'
      AND e.symbol = 'USDA'
      AND e.direction = 'below'
      AND e.source = 'live'
      AND e.started_at = 1780680099
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
      AND l.event_id = 90091
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90091
      AND a.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0148'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0148'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90091
  AND a.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0148'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:b771f571c67373f4c4525039afc1a65b',
  90091,
  'repair_replacement',
  a.id,
  unixepoch(),
  'sealed incident reopen linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90091
  AND a.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0148'
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
  90091,
  'ddr2:b771f571c67373f4c4525039afc1a65b',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  'USDA reopen is the current source event for the sealed canonical incident',
  unixepoch(),
  4102444800,
  'migration-0148'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
      AND l.event_id = 90091
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
      AND i.current_event_id = 90078
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90091
      AND a.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0148'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0148'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90091
  AND a.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0148'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:b771f571c67373f4c4525039afc1a65b',
  90078,
  90091,
  'sealed incident reopen adopted as current source event',
  a.id,
  NULL,
  unixepoch(),
  'migration-0148'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90091
  AND a.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0148'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
      AND existing.previous_event_id = 90078
      AND existing.current_event_id = 90091
      AND existing.reason = 'sealed incident reopen adopted as current source event'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90091,
    current_started_at = 1780680099,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
  AND current_event_id = 90078
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
      AND l.event_id = 90091
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:b771f571c67373f4c4525039afc1a65b'
      AND r.previous_event_id = 90078
      AND r.current_event_id = 90091
      AND r.reason = 'sealed incident reopen adopted as current source event'
  );
