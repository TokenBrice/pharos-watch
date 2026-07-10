-- rollout-safety: backward-compatible
-- Add durable mint/burn historical-price repair state and close the reviewed
-- BRLA DDR repair tasks through explicit, append-only repair provenance.

ALTER TABLE mint_burn_events ADD COLUMN price_repair_status TEXT
  CHECK (price_repair_status IN ('pending_aggregate', 'recovered', 'irreducible'));
ALTER TABLE mint_burn_events ADD COLUMN price_repair_reason TEXT;
ALTER TABLE mint_burn_events ADD COLUMN price_repair_attempted_at INTEGER;
ALTER TABLE mint_burn_events ADD COLUMN price_repair_run_id TEXT;
ALTER TABLE mint_burn_events ADD COLUMN price_repair_bookmark TEXT;

CREATE INDEX IF NOT EXISTS idx_mbe_historical_price_repair_backlog
  ON mint_burn_events(price_repair_status, price_repair_attempted_at ASC, timestamp ASC, id ASC)
  WHERE amount_usd IS NULL OR price_repair_status = 'pending_aggregate';

-- Events 90492, 90493, and 90494 are recovered BRLA below-peg backfill flaps
-- separated from event 90491 by gaps inside the canonical incident merge
-- window. The incident has no sealed public prediction, so the manual repair
-- appends explicit link authorizations before advancing its current event.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  e.id,
  'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d',
  'incident_link',
  '["event_id","incident_key"]',
  NULL,
  NULL,
  'BRLA recovered backfill flap belongs to the unsealed event 90491 canonical incident',
  unixepoch(),
  4102444800,
  'migration-0178'
FROM depeg_events e
WHERE e.id IN (90492, 90493, 90494)
  AND e.stablecoin_id = 'brla-brla-digital'
  AND e.symbol = 'BRLA'
  AND e.peg_type = 'peggedBRL'
  AND e.direction = 'below'
  AND e.source = 'backfill'
  AND (
    (e.id = 90492 AND e.started_at = 1782723750 AND e.ended_at = 1782730804 AND e.peak_deviation_bps = -151)
    OR (e.id = 90493 AND e.started_at = 1782734422 AND e.ended_at = 1782741747 AND e.peak_deviation_bps = -154)
    OR (e.id = 90494 AND e.started_at = 1782853271 AND e.ended_at = 1782910849 AND e.peak_deviation_bps = -230)
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
      AND i.stablecoin_id = 'brla-brla-digital'
      AND i.first_event_id = 90491
      AND i.current_event_id = 90491
      AND i.incident_state = 'active'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links canonical
    WHERE canonical.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
      AND canonical.event_id = 90491
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = e.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = e.id
      AND a.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0178'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT
  a.id,
  a.event_id,
  a.incident_key,
  a.operation,
  unixepoch(),
  'migration-0178'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90492, 90493, 90494)
  AND a.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0178'
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
  'recovered BRLA backfill flap linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90492, 90493, 90494)
  AND a.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0178'
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

-- Event 90496 reopens inside the unsealed event 90495 incident window.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  90496,
  'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e',
  'incident_link',
  '["event_id","incident_key"]',
  NULL,
  NULL,
  'BRLA recovered backfill flap belongs to the unsealed event 90495 canonical incident',
  unixepoch(),
  4102444800,
  'migration-0178'
FROM depeg_events e
WHERE e.id = 90496
  AND e.stablecoin_id = 'brla-brla-digital'
  AND e.symbol = 'BRLA'
  AND e.peg_type = 'peggedBRL'
  AND e.direction = 'below'
  AND e.source = 'backfill'
  AND e.started_at = 1783080116
  AND e.ended_at = 1783368059
  AND e.peak_deviation_bps = -242
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
      AND i.stablecoin_id = 'brla-brla-digital'
      AND i.first_event_id = 90495
      AND i.current_event_id = 90495
      AND i.incident_state = 'active'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links canonical
    WHERE canonical.incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
      AND canonical.event_id = 90495
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = 90496
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90496
      AND a.incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
      AND a.operation = 'incident_link'
      AND a.created_by = 'migration-0178'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0178'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90496
  AND a.incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0178'
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
  'recovered BRLA backfill flap linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90496
  AND a.incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0178'
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

-- Advance each unsealed incident only after every reviewed link exists.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  target.event_id,
  target.incident_key,
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  target.reason,
  unixepoch(),
  4102444800,
  'migration-0178'
FROM (
  SELECT
    90494 AS event_id,
    'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d' AS incident_key,
    'latest reviewed BRLA backfill flap is the current source event for the event 90491 incident' AS reason
  UNION ALL
  SELECT
    90496,
    'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e',
    'latest reviewed BRLA backfill flap is the current source event for the event 90495 incident'
) target
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = target.incident_key
      AND l.event_id = target.event_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = target.incident_key
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = target.event_id
      AND a.incident_key = target.incident_key
      AND a.operation = 'incident_current_update'
      AND a.created_by = 'migration-0178'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0178'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90494, 90496)
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0178'
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
  CASE a.event_id WHEN 90494 THEN 90491 ELSE 90495 END,
  a.event_id,
  'reviewed BRLA backfill flaps adopted by the unsealed canonical incident',
  a.id,
  NULL,
  unixepoch(),
  'migration-0178'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id IN (90494, 90496)
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0178'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = a.incident_key
      AND r.current_event_id = a.event_id
      AND r.created_by = 'migration-0178'
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90494,
    current_started_at = 1782853271,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
  AND current_event_id = 90491
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
  )
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
      AND r.previous_event_id = 90491
      AND r.current_event_id = 90494
      AND r.created_by = 'migration-0178'
  )
  AND 3 = (
    SELECT COUNT(*) FROM depeg_resolver_incident_event_links l
    WHERE l.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
      AND l.event_id IN (90492, 90493, 90494)
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90496,
    current_started_at = 1783080116,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
  AND current_event_id = 90495
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
  )
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
      AND r.previous_event_id = 90495
      AND r.current_event_id = 90496
      AND r.created_by = 'migration-0178'
  );

UPDATE worker_repair_tasks
SET state = 'closed',
    locked_by = NULL,
    locked_until = NULL,
    last_error = NULL,
    updated_at = unixepoch(),
    closed_at = unixepoch()
WHERE kind = 'ddr-repair-required-event'
  AND subject_id IN ('90492', '90493', '90494', '90496')
  AND state IN ('open', 'claimed', 'deferred', 'failed')
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = l.repair_authorization_id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = 'incident_link'
    WHERE CAST(l.event_id AS TEXT) = worker_repair_tasks.subject_id
  )
  AND (
    subject_id NOT IN ('90494', '90496')
    OR EXISTS (
      SELECT 1
      FROM depeg_resolver_incidents i
      WHERE i.current_event_id = CAST(worker_repair_tasks.subject_id AS INTEGER)
        AND i.incident_state = 'active'
    )
  );

-- Force both projections to regenerate from the repaired incident lineage.
UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-brla-ddr-repair-0178","payload":{}}',
    updated_at = unixepoch()
WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
  AND 4 = (
    SELECT COUNT(DISTINCT l.event_id)
    FROM worker_repair_tasks t
    JOIN depeg_resolver_incident_event_links l
      ON CAST(l.event_id AS TEXT) = t.subject_id
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = l.repair_authorization_id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = 'incident_link'
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.subject_id IN ('90492', '90493', '90494', '90496')
      AND t.state = 'closed'
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
    WHERE CAST(json_extract(event.value, '$.eventId') AS INTEGER)
      NOT IN (90492, 90493, 90494, 90496)
  )
  AND 4 = (
    SELECT COUNT(DISTINCT l.event_id)
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = l.repair_authorization_id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = 'incident_link'
    WHERE l.event_id IN (90492, 90493, 90494, 90496)
  )
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:0c95520aa5c8a0c1529cf911bdeb1f2d'
      AND i.current_event_id = 90494
  )
  AND EXISTS (
    SELECT 1 FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:fd0c5d2bd3c92ebd1acbd52ec2cfae2e'
      AND i.current_event_id = 90496
  );
