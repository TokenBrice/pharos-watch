-- rollout-safety: backward-compatible
-- Link the reviewed cNGN recovered live flap to its unsealed canonical
-- incident and close the durable DDR repair task.

INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  90548,
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  'incident_link',
  '["event_id","incident_key"]',
  NULL,
  NULL,
  'cNGN recovered live flap belongs to the unsealed event 90511 canonical incident',
  unixepoch(),
  4102444800,
  'migration-0203'
FROM depeg_events e
WHERE e.id = 90548
  AND e.stablecoin_id = 'cngn-compliant-naira'
  AND e.symbol = 'cNGN'
  AND e.peg_type = 'peggedNGN'
  AND e.direction = 'below'
  AND e.started_at = 1783946864
  AND e.ended_at = 1783947766
  AND e.peak_deviation_bps = -172
  AND e.start_price = 0.982818
  AND e.peak_price = 0.982818
  AND e.recovery_price = 0.989082
  AND e.peg_reference = 1
  AND e.source = 'live'
  AND e.close_reason = 'recovered-native'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.stablecoin_id = 'cngn-compliant-naira'
      AND i.peg_currency = 'NGN'
      AND i.direction = 'below'
      AND i.first_event_id = 90511
      AND i.current_event_id = 90526
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links canonical
    WHERE canonical.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND canonical.event_id = 90511
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = 90548
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90548
      AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0203'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0203'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90548
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0203'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT OR IGNORE INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  a.incident_key,
  a.event_id,
  'repair_replacement',
  a.id,
  unixepoch(),
  'recovered cNGN live flap linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90548
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0203'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = a.event_id
  );

INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  90548,
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  'latest reviewed cNGN live flap is the current source event for the event 90511 incident',
  unixepoch(),
  4102444800,
  'migration-0203'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id = 90548
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90526
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90548
      AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0203'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0203'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90548
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0203'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_revisions
  (incident_key, previous_event_id, current_event_id, reason, repair_authorization_id,
   erratum_id, created_at, created_by)
SELECT
  a.incident_key,
  90526,
  90548,
  'reviewed cNGN live flap adopted by the unsealed canonical incident',
  a.id,
  NULL,
  unixepoch(),
  'migration-0203'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90548
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0203'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = a.incident_key
      AND r.previous_event_id = 90526
      AND r.current_event_id = 90548
      AND r.created_by = 'migration-0203'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90548,
    current_started_at = 1783946864,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND current_event_id = 90526
  AND incident_state = 'active'
  AND superseded_by_incident_key IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90526
      AND r.current_event_id = 90548
      AND r.created_by = 'migration-0203'
  );

UPDATE worker_repair_tasks
SET state = 'closed',
    locked_by = NULL,
    locked_until = NULL,
    last_error = NULL,
    updated_at = unixepoch(),
    closed_at = unixepoch()
WHERE kind = 'ddr-repair-required-event'
  AND subject_id = '90548'
  AND state IN ('open', 'claimed', 'deferred', 'failed')
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = l.repair_authorization_id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = 'incident_link'
    WHERE l.event_id = 90548
      AND l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90548
      AND i.incident_state = 'active'
  );

-- Force both projections to regenerate from the repaired incident lineage.
UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-cngn-ddr-repair-0203","payload":{}}',
    updated_at = unixepoch()
WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
  AND EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id = '90548'
      AND t.state = 'closed'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90548
  );

DELETE FROM cache
WHERE key = 'ddr:repair-debt:v1'
  AND NOT EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(value, '$.events') event
    WHERE CAST(json_extract(event.value, '$.eventId') AS INTEGER) != 90548
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = l.repair_authorization_id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = 'incident_link'
    WHERE l.event_id = 90548
      AND l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90548
  );
