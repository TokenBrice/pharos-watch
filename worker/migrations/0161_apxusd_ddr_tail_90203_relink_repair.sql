-- rollout-safety: backward-compatible
-- Repair APXUSD tail event 90203 on databases where migration 0154 could not
-- insert the canonical link because the event was already linked to the
-- accidental fresh incident.

DROP TRIGGER IF EXISTS trg_ddr_incident_links_no_update;

UPDATE depeg_resolver_incident_event_links
SET incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776',
    relation = 'repair_replacement',
    repair_authorization_id = (
      SELECT a.id
      FROM depeg_resolver_event_repair_authorizations a
      WHERE a.event_id = 90203
        AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
        AND a.operation = 'incident_link'
        AND a.created_by = 'migration-0154'
    ),
    note = 'sealed incident tail relinked from accidental fresh incident through explicit repair authorization'
WHERE incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  AND event_id = 90203
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
    WHERE a.event_id = 90203
      AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0154'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents accidental
    WHERE accidental.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
      AND accidental.stablecoin_id = 'apxusd-apyx'
      AND accidental.first_event_id = 90203
      AND accidental.current_event_id = 90203
      AND accidental.incident_state = 'active'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links canonical
    WHERE canonical.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND canonical.event_id = 90203
  );

CREATE TRIGGER IF NOT EXISTS trg_ddr_incident_links_no_update
BEFORE UPDATE ON depeg_resolver_incident_event_links
BEGIN
  SELECT RAISE(ABORT, 'incident event links are append-only');
END;

INSERT OR IGNORE INTO depeg_resolver_event_repair_authorization_uses
  (authorization_id, event_id, incident_key, operation, used_at, target_table, target_key)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(),
       'depeg_resolver_incident_event_links',
       a.incident_key || ':' || a.event_id
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
JOIN depeg_resolver_incident_event_links l
  ON l.incident_key = a.incident_key
 AND l.event_id = a.event_id
WHERE a.event_id = 90203
  AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0154'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_uses u
    WHERE u.authorization_id = a.id
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  'ddr2:e32c8186781838eac1b740a44c3b8776',
  90203,
  'repair_replacement',
  a.id,
  unixepoch(),
  'sealed incident tail linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90203
  AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0154'
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

UPDATE depeg_resolver_incidents
SET incident_state = 'superseded',
    superseded_by_incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776',
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  AND stablecoin_id = 'apxusd-apyx'
  AND first_event_id = 90203
  AND current_event_id = 90203
  AND incident_state = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:70a8e43c093e0afcdc8a37143a6849f9'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links canonical
    WHERE canonical.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND canonical.event_id = 90203
  );

DROP INDEX IF EXISTS idx_ddr_incident_current_event;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ddr_incident_current_event
  ON depeg_resolver_incidents(current_event_id)
  WHERE incident_state = 'active';

INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id, reason, created_at, expires_at, created_by)
SELECT
  90203,
  'ddr2:e32c8186781838eac1b740a44c3b8776',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  'APXUSD tail event 90203 is the current source event for the sealed canonical incident',
  unixepoch(),
  4102444800,
  'migration-0161'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND l.event_id = 90203
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND i.current_event_id = 90089
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90203
      AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0161'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0161'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90203
  AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0161'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id, erratum_id, created_at, created_by)
SELECT
  'ddr2:e32c8186781838eac1b740a44c3b8776',
  90089,
  90203,
  'sealed APXUSD tail event adopted as current source event',
  a.id,
  NULL,
  unixepoch(),
  'migration-0161'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90203
  AND a.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0161'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions existing
    WHERE existing.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND existing.previous_event_id = 90089
      AND existing.current_event_id = 90203
      AND existing.reason = 'sealed APXUSD tail event adopted as current source event'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90203,
    current_started_at = 1781632159,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
  AND current_event_id = 90089
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND l.event_id = 90203
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:e32c8186781838eac1b740a44c3b8776'
      AND r.previous_event_id = 90089
      AND r.current_event_id = 90203
      AND r.reason = 'sealed APXUSD tail event adopted as current source event'
  );

UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-apxusd-tail-90203-relink","payload":{}}',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER)
WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot');
