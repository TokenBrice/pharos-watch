-- rollout-safety: backward-compatible
-- Link the reviewed cNGN live reopen to its active, unsealed canonical
-- incident and advance the current source pointer without mutating the event.

-- Authorize the link only while the immutable source identity, reviewed
-- predecessor, prior repair lineage, active task, and canonical incident all
-- still match the production state captured for this repair.
INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  90599,
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  'incident_link',
  '["event_id","incident_key"]',
  NULL,
  NULL,
  'cNGN live reopen 90599 belongs to the unsealed event 90511 canonical incident',
  unixepoch(),
  4102444800,
  'migration-0209'
FROM depeg_events e
WHERE e.id = 90599
  AND e.stablecoin_id = 'cngn-compliant-naira'
  AND e.symbol = 'cNGN'
  AND e.peg_type = 'peggedNGN'
  AND e.direction = 'below'
  AND e.started_at = 1784151172
  AND e.start_price = 0.984154
  AND e.peg_reference = 1
  AND e.source = 'live'
  AND e.confirmation_sources IS NULL
  AND e.pending_reason IS NULL
  AND EXISTS (
    SELECT 1
    FROM depeg_events predecessor
    WHERE predecessor.id = 90584
      AND predecessor.stablecoin_id = 'cngn-compliant-naira'
      AND predecessor.symbol = 'cNGN'
      AND predecessor.peg_type = 'peggedNGN'
      AND predecessor.direction = 'below'
      AND predecessor.peak_deviation_bps = -150
      AND predecessor.started_at = 1784108016
      AND predecessor.ended_at = 1784108885
      AND predecessor.start_price = 0.98504
      AND predecessor.peak_price = 0.98504
      AND predecessor.recovery_price = 0.985101
      AND predecessor.peg_reference = 1
      AND predecessor.source = 'live'
      AND predecessor.confirmation_sources IS NULL
      AND predecessor.pending_reason IS NULL
      AND predecessor.close_reason = 'recovered-native'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.stablecoin_id = 'cngn-compliant-naira'
      AND i.peg_currency = 'NGN'
      AND i.direction = 'below'
      AND i.first_event_id = 90511
      AND i.current_event_id = 90584
      AND i.first_started_at = 1783650896
      AND i.current_started_at = 1784108016
      AND i.first_observed_peak_bucket_bps = 150
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
      AND i.source_fingerprint = 'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links first_link
    WHERE first_link.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND first_link.event_id = 90511
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links current_link
    JOIN depeg_resolver_event_repair_authorizations prior_auth
      ON prior_auth.id = current_link.repair_authorization_id
     AND prior_auth.event_id = current_link.event_id
     AND prior_auth.incident_key = current_link.incident_key
     AND prior_auth.operation = 'incident_link'
     AND prior_auth.created_by = 'migration-0206'
    JOIN depeg_resolver_event_repair_authorization_consumptions prior_consumption
      ON prior_consumption.authorization_id = prior_auth.id
     AND prior_consumption.event_id = prior_auth.event_id
     AND prior_consumption.incident_key = prior_auth.incident_key
     AND prior_consumption.operation = prior_auth.operation
    WHERE current_link.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND current_link.event_id = 90584
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    JOIN depeg_resolver_event_repair_authorizations prior_auth
      ON prior_auth.id = r.repair_authorization_id
     AND prior_auth.event_id = r.current_event_id
     AND prior_auth.incident_key = r.incident_key
     AND prior_auth.operation = 'incident_current_update'
     AND prior_auth.created_by = 'migration-0206'
    JOIN depeg_resolver_event_repair_authorization_consumptions prior_consumption
      ON prior_consumption.authorization_id = prior_auth.id
     AND prior_consumption.event_id = prior_auth.event_id
     AND prior_consumption.incident_key = prior_auth.incident_key
     AND prior_consumption.operation = prior_auth.operation
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90576
      AND r.current_event_id = 90584
      AND r.created_by = 'migration-0206'
  )
  AND EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.task_id = 'repair:ddr-repair-required-event:90599'
      AND t.kind = 'ddr-repair-required-event'
      AND t.subject_id = '90599'
      AND t.priority = 50
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
      AND t.payload_json = '{"eventId":90599,"reason":"Unlinked depeg event 90599 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = 90599
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90599
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0209'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90599
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0209'
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorization_consumptions c
    WHERE c.authorization_id = a.id
  );

INSERT INTO depeg_resolver_incident_event_links
  (incident_key, event_id, relation, repair_authorization_id, linked_at, note)
SELECT
  a.incident_key,
  a.event_id,
  'repair_replacement',
  a.id,
  unixepoch(),
  'reviewed cNGN live reopen linked through explicit repair authorization'
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE a.event_id = 90599
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_link'
  AND a.created_by = 'migration-0209'
  AND EXISTS (
    SELECT 1
    FROM depeg_events e
    WHERE e.id = 90599
      AND e.stablecoin_id = 'cngn-compliant-naira'
      AND e.symbol = 'cNGN'
      AND e.peg_type = 'peggedNGN'
      AND e.direction = 'below'
      AND e.started_at = 1784151172
      AND e.start_price = 0.984154
      AND e.peg_reference = 1
      AND e.source = 'live'
      AND e.confirmation_sources IS NULL
      AND e.pending_reason IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = a.incident_key
      AND i.current_event_id = 90584
      AND i.current_started_at = 1784108016
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = a.incident_key
  )
  AND EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.task_id = 'repair:ddr-repair-required-event:90599'
      AND t.kind = 'ddr-repair-required-event'
      AND t.subject_id = '90599'
      AND t.priority = 50
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
      AND t.payload_json = '{"eventId":90599,"reason":"Unlinked depeg event 90599 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}'
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_incident_event_links l
    WHERE l.event_id = a.event_id
  );

INSERT INTO depeg_resolver_event_repair_authorizations
  (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id,
   reason, created_at, expires_at, created_by)
SELECT
  90599,
  'ddr2:d71d5088a08922584d989cfe03ae8388',
  'incident_current_update',
  '["current_event_id","current_started_at"]',
  NULL,
  NULL,
  'reviewed cNGN live reopen 90599 follows event 90584 as the canonical current source',
  unixepoch(),
  4102444800,
  'migration-0209'
WHERE EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations link_auth
      ON link_auth.id = l.repair_authorization_id
     AND link_auth.operation = 'incident_link'
     AND link_auth.created_by = 'migration-0209'
    JOIN depeg_resolver_event_repair_authorization_consumptions link_consumption
      ON link_consumption.authorization_id = link_auth.id
     AND link_consumption.event_id = l.event_id
     AND link_consumption.incident_key = l.incident_key
     AND link_consumption.operation = link_auth.operation
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id = 90599
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90584
      AND i.current_started_at = 1784108016
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.task_id = 'repair:ddr-repair-required-event:90599'
      AND t.kind = 'ddr-repair-required-event'
      AND t.subject_id = '90599'
      AND t.priority = 50
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
      AND t.payload_json = '{"eventId":90599,"reason":"Unlinked depeg event 90599 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_event_repair_authorizations a
    WHERE a.event_id = 90599
      AND a.operation = 'incident_current_update'
  );

INSERT INTO depeg_resolver_event_repair_authorization_consumptions
  (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
SELECT a.id, a.event_id, a.incident_key, a.operation, unixepoch(), 'migration-0209'
FROM depeg_resolver_event_repair_authorizations a
WHERE a.event_id = 90599
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0209'
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
  90584,
  90599,
  'reviewed cNGN live reopen 90599 adopted after event 90584',
  a.id,
  NULL,
  unixepoch(),
  'migration-0209'
FROM depeg_resolver_event_repair_authorizations a
JOIN depeg_resolver_event_repair_authorization_consumptions c
  ON c.authorization_id = a.id
 AND c.event_id = a.event_id
 AND c.incident_key = a.incident_key
 AND c.operation = a.operation
WHERE a.event_id = 90599
  AND a.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND a.operation = 'incident_current_update'
  AND a.created_by = 'migration-0209'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = a.incident_key
      AND i.current_event_id = 90584
      AND i.current_started_at = 1784108016
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = a.incident_key
  )
  AND NOT EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = a.incident_key
      AND r.previous_event_id = 90584
      AND r.current_event_id = 90599
  );

UPDATE depeg_resolver_incidents
SET current_event_id = 90599,
    current_started_at = 1784151172,
    updated_at = unixepoch()
WHERE incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  AND stablecoin_id = 'cngn-compliant-naira'
  AND peg_currency = 'NGN'
  AND direction = 'below'
  AND first_event_id = 90511
  AND current_event_id = 90584
  AND first_started_at = 1783650896
  AND current_started_at = 1784108016
  AND first_observed_peak_bucket_bps = 150
  AND incident_state = 'active'
  AND superseded_by_incident_key IS NULL
  AND source_fingerprint = 'b34dc1832aa964c5828d0b50ac025a4181efdd854c644c14281838490b644a15'
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_events e
    WHERE e.id = 90599
      AND e.stablecoin_id = 'cngn-compliant-naira'
      AND e.symbol = 'cNGN'
      AND e.peg_type = 'peggedNGN'
      AND e.direction = 'below'
      AND e.started_at = 1784151172
      AND e.start_price = 0.984154
      AND e.peg_reference = 1
      AND e.source = 'live'
      AND e.confirmation_sources IS NULL
      AND e.pending_reason IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = r.repair_authorization_id
     AND a.operation = 'incident_current_update'
     AND a.created_by = 'migration-0209'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = a.event_id
     AND c.incident_key = a.incident_key
     AND c.operation = a.operation
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90584
      AND r.current_event_id = 90599
      AND r.created_by = 'migration-0209'
  );

UPDATE worker_repair_tasks
SET state = 'closed',
    locked_by = NULL,
    locked_until = NULL,
    last_error = NULL,
    updated_at = unixepoch(),
    closed_at = unixepoch()
WHERE task_id = 'repair:ddr-repair-required-event:90599'
  AND kind = 'ddr-repair-required-event'
  AND subject_id = '90599'
  AND priority = 50
  AND state IN ('open', 'claimed', 'deferred', 'failed')
  AND payload_json = '{"eventId":90599,"reason":"Unlinked depeg event 90599 overlaps nearby canonical incident ddr2:d71d5088a08922584d989cfe03ae8388; explicit repair required"}'
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0209'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id = 90599
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90584
      AND r.current_event_id = 90599
      AND r.created_by = 'migration-0209'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90599
      AND i.current_started_at = 1784151172
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM depeg_resolver_public_predictions p
    WHERE p.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
  );

-- Force both projections to regenerate from the repaired canonical lineage.
UPDATE cache
SET value = '{"generation":-1,"methodologyVersion":"invalidated-cngn-ddr-repair-0209","payload":{}}',
    updated_at = unixepoch()
WHERE key IN ('depeg-resolver:snapshot', 'depeg-resolver-review:snapshot')
  AND EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.task_id = 'repair:ddr-repair-required-event:90599'
      AND t.state = 'closed'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_revisions r
    WHERE r.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND r.previous_event_id = 90584
      AND r.current_event_id = 90599
      AND r.created_by = 'migration-0209'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90599
      AND i.current_started_at = 1784151172
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  );

DELETE FROM cache
WHERE key = 'ddr:repair-debt:v1'
  AND json_valid(value)
  AND json_type(value, '$.events') = 'array'
  AND json_array_length(value, '$.events') = 1
  AND json_type(value, '$.count') = 'integer'
  AND json_extract(value, '$.count') = 1
  AND json_extract(value, '$.eventsTruncated') = 0
  AND 1 = (
    SELECT COUNT(DISTINCT CAST(json_extract(event.value, '$.eventId') AS INTEGER))
    FROM json_each(cache.value, '$.events') event
  )
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(cache.value, '$.events') event
    WHERE json_type(event.value, '$.eventId') IS NOT 'integer'
       OR CAST(json_extract(event.value, '$.eventId') AS INTEGER) != 90599
  )
  AND NOT EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.kind = 'ddr-repair-required-event'
      AND t.state IN ('open', 'claimed', 'deferred', 'failed')
  )
  AND EXISTS (
    SELECT 1
    FROM worker_repair_tasks t
    WHERE t.task_id = 'repair:ddr-repair-required-event:90599'
      AND t.kind = 'ddr-repair-required-event'
      AND t.subject_id = '90599'
      AND t.state = 'closed'
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incident_event_links l
    JOIN depeg_resolver_event_repair_authorizations a
      ON a.id = l.repair_authorization_id
     AND a.operation = 'incident_link'
     AND a.created_by = 'migration-0209'
    JOIN depeg_resolver_event_repair_authorization_consumptions c
      ON c.authorization_id = a.id
     AND c.event_id = l.event_id
     AND c.incident_key = l.incident_key
     AND c.operation = a.operation
    WHERE l.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND l.event_id = 90599
  )
  AND EXISTS (
    SELECT 1
    FROM depeg_resolver_incidents i
    WHERE i.incident_key = 'ddr2:d71d5088a08922584d989cfe03ae8388'
      AND i.current_event_id = 90599
      AND i.current_started_at = 1784151172
      AND i.incident_state = 'active'
      AND i.superseded_by_incident_key IS NULL
  );
