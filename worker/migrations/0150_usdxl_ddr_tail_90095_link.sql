-- rollout-safety: backward-compatible
-- Link the next USDXL below-peg sealed DDR incident tail.
--
-- Event 90095 reopened inside DDR's sticky incident window after event 90090
-- had a public prediction sealed and after migration 0149 advanced the
-- canonical current source to event 90094. Link event 90095 through the sealed
-- repair authorization path and advance the canonical current source.

INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id, reason, created_at, expires_at, created_by)
SELECT
  90095,
  'ddr2:191d8a3d2d947537a22e8b973ba54b9d',
  'incident_link',
  '["event_id","incident_key"]',
  NULL,
  NULL,
  'USDXL live tail event reopened within DDR incident merge window after sealed prediction',
  unixepoch(),
  4102444800,
  'migration-0150'
WHERE EXISTS (
    SELECT 1
    FROM depeg_events e
    WHERE e.id = 90095
      AND e.stablecoin_id = 'usdxl-last'
      AND e.symbol = 'USDXL'
      AND e.direction = 'below'
      AND e.source = 'live'
      AND e.started_at = 1780696209
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
      AND l.event_id = 90095
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90095
      AND a.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0150'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0150'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90095
  AND a.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0150'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:191d8a3d2d947537a22e8b973ba54b9d',
  90095,
  'repair_replacement',
  a.id,
  unixepoch(),
  'sealed incident live tail linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90095
  AND a.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0150'
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
  90095,
  'ddr2:191d8a3d2d947537a22e8b973ba54b9d',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  'USDXL live tail event is the current source event for the sealed canonical incident',
  unixepoch(),
  4102444800,
  'migration-0150'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
      AND l.event_id = 90095
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
      AND i.current_event_id = 90094
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90095
      AND a.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0150'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0150'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90095
  AND a.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0150'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:191d8a3d2d947537a22e8b973ba54b9d',
  90094,
  90095,
  'sealed incident live tail adopted as current source event',
  a.id,
  NULL,
  unixepoch(),
  'migration-0150'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90095
  AND a.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0150'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
      AND existing.previous_event_id = 90094
      AND existing.current_event_id = 90095
      AND existing.reason = 'sealed incident live tail adopted as current source event'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90095,
    current_started_at = 1780696209,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
  AND current_event_id = 90094
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
      AND l.event_id = 90095
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:191d8a3d2d947537a22e8b973ba54b9d'
      AND r.previous_event_id = 90094
      AND r.current_event_id = 90095
      AND r.reason = 'sealed incident live tail adopted as current source event'
  );
